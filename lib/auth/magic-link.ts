/**
 * Magic-Link-Token-Lib (Phase ORG SP-3).
 *
 * Token strategy:
 *   - format: `lzy_<43-base64url-chars>` → 32 random bytes, high entropy
 *   - storage: SHA-256 hash, NEVER plaintext
 *   - TTL: 30 minutes (env-configurable)
 *   - single-use: set `consumed_at` on verify; second verify → 'duplicate'
 *   - purge: `purge_after = consumed_at + 24h` OR `expires_at + 24h`
 *
 * GDPR:
 *   - email + ip + ua are personal data (Art. 6(1)(f) legitimate interest)
 *   - cleanup cron prunes tokens 24h after use → data minimization
 */

import { createHash, randomBytes } from "node:crypto";

import { and, eq, lte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  magicTokens,
  type MagicTokenIntent,
  type MagicTokenRow,
} from "@/db/schema/magic_tokens";
import { ulid } from "@/lib/ulid";

export const MAGIC_TOKEN_TTL_MS = (() => {
  const raw = process.env.LAZYOS_MAGIC_TTL_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 60_000 && n < 24 * 60 * 60 * 1000) return n;
  }
  return 30 * 60 * 1000; // 30 minutes default
})();

/** Tokens are purged 24h after use OR expiry. */
const POST_USE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IssueTokenInput {
  email: string;
  intent: MagicTokenIntent;
  intentOrgId?: string | null;
  intentWorkspaceId?: string | null;
  intentRole?: string | null;
  issuedByUserId?: string | null;
}

export interface IssueTokenResult {
  /** Klartext-Token. NUR ZUM IMMEDIATEN VERSAND. Niemals speichern. */
  rawToken: string;
  tokenId: string;
  expiresAt: Date;
}

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function newRawToken(): string {
  return `lzy_${randomBytes(32).toString("base64url")}`;
}

/**
 * Issues a new magic token. Stores only the hash. Returns plaintext
 * for the email send — the caller must have it available immediately and
 * persist it nowhere.
 */
export function issueToken(input: IssueTokenInput): IssueTokenResult {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) {
    throw new Error(`issueToken: invalid email '${email}'`);
  }
  const rawToken = newRawToken();
  const tokenHash = hashToken(rawToken);
  const id = `mtk_${ulid()}`;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + MAGIC_TOKEN_TTL_MS);
  const purgeAfter = new Date(expiresAt.getTime() + POST_USE_RETENTION_MS);

  const db = getDb();
  db.insert(magicTokens)
    .values({
      id,
      tokenHash,
      email,
      intent: input.intent,
      intentOrgId: input.intentOrgId ?? null,
      intentWorkspaceId: input.intentWorkspaceId ?? null,
      intentRole: input.intentRole ?? null,
      issuedByUserId: input.issuedByUserId ?? null,
      issuedAt,
      expiresAt,
      consumedAt: null,
      consumedIp: null,
      consumedUserAgent: null,
      purgeAfter,
    })
    .run();
  return { rawToken, tokenId: id, expiresAt };
}

export type VerifyTokenResult =
  | { ok: true; token: MagicTokenRow }
  | { ok: false; reason: "invalid" | "expired" | "consumed" | "purged" };

/**
 * Verifies + consumes a magic-token in a single atomic step.
 * On `ok: true`, the caller gets the row with the intent payload for login/membership creation.
 */
export function verifyAndConsumeToken(
  rawToken: string,
  consumeContext: { ip?: string | null; userAgent?: string | null } = {},
  now: Date = new Date(),
): VerifyTokenResult {
  if (!rawToken || !rawToken.startsWith("lzy_")) {
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = hashToken(rawToken);
  const db = getDb();
  const rows = db
    .select()
    .from(magicTokens)
    .where(eq(magicTokens.tokenHash, tokenHash))
    .limit(1)
    .all();
  const row = rows[0];
  if (!row) return { ok: false, reason: "invalid" };

  // Already consumed?
  if (row.consumedAt) {
    return { ok: false, reason: "consumed" };
  }
  // Expired?
  const expiresAtMs =
    row.expiresAt instanceof Date ? row.expiresAt.getTime() : Number(row.expiresAt);
  if (expiresAtMs <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  // Consume.
  db.update(magicTokens)
    .set({
      consumedAt: now,
      consumedIp: consumeContext.ip ?? null,
      consumedUserAgent: consumeContext.userAgent ?? null,
      // purgeAfter is reset on consume: use+24h. If it stays empty
      // (consume but token never expired-cleared), it is cleaned up
      // by the cron anyway.
      purgeAfter: new Date(now.getTime() + POST_USE_RETENTION_MS),
    })
    .where(eq(magicTokens.id, row.id))
    .run();

  // Re-read to return the updated row.
  const fresh = db
    .select()
    .from(magicTokens)
    .where(eq(magicTokens.id, row.id))
    .limit(1)
    .all();
  return { ok: true, token: fresh[0] ?? row };
}

/**
 * Cleanup cron helper: deletes all tokens whose `purge_after < now`.
 */
export function purgeExpiredTokens(now: Date = new Date()): { deleted: number } {
  const db = getDb();
  const result = db.$raw
    .prepare("DELETE FROM magic_tokens WHERE purge_after < ?")
    .run(now.getTime());
  return { deleted: result.changes ?? 0 };
}

/**
 * Rate-limit check: how many tokens has an email issued in the last hour?
 * If ≥ MAX_PER_HOUR → return false (caller must throw 429).
 */
export const MAX_TOKENS_PER_HOUR_PER_EMAIL = 5;

export function canIssueTokenForEmail(
  email: string,
  now: Date = new Date(),
): { ok: boolean; recentCount: number } {
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const db = getDb();
  const rows = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(magicTokens)
    .where(
      and(
        eq(magicTokens.email, email.trim().toLowerCase()),
        sql`${magicTokens.issuedAt} > ${cutoff.getTime()}`,
      ),
    )
    .all();
  const count = Number(rows[0]?.n ?? 0);
  return {
    ok: count < MAX_TOKENS_PER_HOUR_PER_EMAIL,
    recentCount: count,
  };
}

// Drizzle utility re-export so callers don't need a separate import.
export { lte };
