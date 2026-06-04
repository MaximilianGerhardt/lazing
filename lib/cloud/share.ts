/**
 * Share-Token-Service (Phase ORG+2).
 *
 * Issues, verifies, revokes public-read tokens for cloud artifacts.
 * Tokens are multi-use (with cap), expiry-bound, optionally password-protected.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, isNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  shareTokens,
  type ShareTokenRow,
} from "@/db/schema/share_tokens";
import { ulid } from "@/lib/ulid";

import { getArtifact, type CloudArtifactRow } from "./service";

const TOKEN_PREFIX = "lzy_share_";

export class ShareError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid"
      | "expired"
      | "revoked"
      | "view-cap-reached"
      | "password-required"
      | "wrong-password"
      | "artifact-missing",
  ) {
    super(message);
    this.name = "ShareError";
  }
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function newRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export interface IssueShareInput {
  artifactId: string;
  workspaceId: string;
  expiresInHours: number;
  maxViews?: number | null;
  password?: string | null;
  createdByUserId: string;
}

export interface IssueShareResult {
  rawToken: string;
  tokenId: string;
  expiresAt: Date;
}

export function issueShareToken(input: IssueShareInput): IssueShareResult {
  if (input.expiresInHours <= 0 || input.expiresInHours > 24 * 365) {
    throw new ShareError(
      `expiresInHours muss in [1..8760] sein`,
      "invalid",
    );
  }
  const rawToken = newRawToken();
  const tokenHash = hashToken(rawToken);
  const id = `shr_${ulid()}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + input.expiresInHours * 60 * 60 * 1000,
  );
  const passwordHash = input.password
    ? createHash("sha256")
        .update("lazyos-share:")
        .update(input.password)
        .digest("hex")
    : null;
  const db = getDb();
  db.insert(shareTokens)
    .values({
      id,
      tokenHash,
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
      createdByUserId: input.createdByUserId,
      passwordHash,
      expiresAt,
      maxViews: input.maxViews ?? null,
      currentViews: 0,
      revokedAt: null,
      revokedByUserId: null,
      createdAt: now,
      lastViewedAt: null,
    })
    .run();
  return { rawToken, tokenId: id, expiresAt };
}

export interface ResolveShareResult {
  token: ShareTokenRow;
  artifact: CloudArtifactRow;
}

export async function resolveAndConsumeShare(
  rawToken: string,
  context: { password?: string | null } = {},
  now: Date = new Date(),
): Promise<ResolveShareResult> {
  if (!rawToken || !rawToken.startsWith(TOKEN_PREFIX)) {
    throw new ShareError("Invalid token format.", "invalid");
  }
  const tokenHash = hashToken(rawToken);
  const db = getDb();
  const rows = db
    .select()
    .from(shareTokens)
    .where(eq(shareTokens.tokenHash, tokenHash))
    .limit(1)
    .all();
  const token = rows[0];
  if (!token) throw new ShareError("Token unbekannt.", "invalid");
  if (token.revokedAt) throw new ShareError("Token revoked.", "revoked");
  const expMs =
    token.expiresAt instanceof Date
      ? token.expiresAt.getTime()
      : Number(token.expiresAt);
  if (expMs <= now.getTime()) {
    throw new ShareError("Token abgelaufen.", "expired");
  }
  if (token.maxViews !== null && token.currentViews >= token.maxViews) {
    throw new ShareError("View-Cap erreicht.", "view-cap-reached");
  }
  // Password-Check (timing-safe).
  if (token.passwordHash) {
    if (!context.password) {
      throw new ShareError("Password erforderlich.", "password-required");
    }
    const candidate = createHash("sha256")
      .update("lazyos-share:")
      .update(context.password)
      .digest("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(token.passwordHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ShareError("Falsches Password.", "wrong-password");
    }
  }
  // Look up the artifact (even if deleted → 404).
  let artifact: CloudArtifactRow;
  try {
    artifact = await getArtifact(token.artifactId, "anon-share-token");
  } catch {
    throw new ShareError("Artifact nicht mehr verfügbar.", "artifact-missing");
  }
  // Inkrement views + last_viewed.
  db.update(shareTokens)
    .set({
      currentViews: token.currentViews + 1,
      lastViewedAt: now,
    })
    .where(eq(shareTokens.id, token.id))
    .run();
  return { token, artifact };
}

export function listSharesForArtifact(artifactId: string): ShareTokenRow[] {
  const db = getDb();
  return db
    .select()
    .from(shareTokens)
    .where(
      and(eq(shareTokens.artifactId, artifactId), isNull(shareTokens.revokedAt)),
    )
    .orderBy(sql`${shareTokens.createdAt} DESC`)
    .all();
}

export function revokeShareToken(
  tokenId: string,
  revokedByUserId: string,
): void {
  const db = getDb();
  db.update(shareTokens)
    .set({
      revokedAt: new Date(),
      revokedByUserId,
    })
    .where(eq(shareTokens.id, tokenId))
    .run();
}

/**
 * Cleanup helper for the ORG+3 cron: deletes tokens that are expired AND have
 * not been used for 7 days (reduce audit footprint).
 */
export function purgeExpiredShares(now: Date = new Date()): { deleted: number } {
  const db = getDb();
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const result = db.$raw
    .prepare(
      "DELETE FROM share_tokens WHERE expires_at < ? AND (last_viewed_at IS NULL OR last_viewed_at < ?)",
    )
    .run(now.getTime(), cutoff);
  return { deleted: result.changes ?? 0 };
}
