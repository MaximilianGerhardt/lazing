/**
 * DB repo for org-level GitHub credentials (Migration 0096, Slice A).
 *
 * Server-only — raw better-sqlite3 prepared statements via `getDb().$raw`
 * (same pattern as `lib/github/repo.ts`).
 *
 * Isolation invariant (SECURITY MANDATE):
 *   - EVERY function filters strictly on `org_id = ?`.
 *   - `encrypted_token` is NEVER returned in plaintext — use
 *     `decryptOrgToken` only when you really need the plaintext
 *     (e.g. for a live GitHub API call).
 *   - `getOrgCredential` is internal and returns the row WITH encrypted_token
 *     (only for `decryptOrgToken` + `upsertOrgCredential`).
 *   - `getOrgCredentialMeta` is the public-safe getter: returns metadata
 *     WITHOUT `encrypted_token` (for status routes / UI panels).
 *   - NEVER write the token to logs or API responses.
 *
 * N8 audit: `decryptOrgToken` writes a best-effort audit row to
 *   `org_github_token_use_audit` (Migration 0106) on every token access.
 *   NO token value in the audit. Idempotency guard via N10 content_hash.
 */

import { createHash, randomUUID } from "node:crypto";

import { getDb } from "@/db/client";
import { canonicalJSON } from "@/lib-v1/audit/canonical-json";
import {
  decryptCredential,
  encryptCredential,
} from "@/lib/security/credentials";

// ─── Row types (raw SQL, not Drizzle-inferred) ─────────────────────

/** Complete row incl. encrypted_token — internal ONLY (getOrgCredential). */
export interface OrgGithubCredentialRow {
  id: string;
  org_id: string;
  auth_kind: "pat" | "oauth" | "github_app";
  /** AES-256-GCM ciphertext — NEVER plaintext. */
  encrypted_token: string;
  github_login: string | null;
  github_user_id: number | null;
  avatar_url: string | null;
  scope: string | null;
  expires_at: number | null;
  last_validated_at: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Public-safe projection without `encrypted_token`.
 *
 * For status routes, UI panels and all callers that only need metadata.
 * `encrypted_token` is NOT included — it does not leave the repo layer.
 */
export interface OrgGithubCredentialMeta {
  id: string;
  org_id: string;
  auth_kind: "pat" | "oauth" | "github_app";
  github_login: string | null;
  github_user_id: number | null;
  avatar_url: string | null;
  scope: string | null;
  expires_at: number | null;
  last_validated_at: number | null;
  created_at: number;
  updated_at: number;
}

// ─── Upsert ───────────────────────────────────────────────────────────

export interface UpsertOrgCredentialInput {
  orgId: string;
  authKind: "pat" | "oauth" | "github_app";
  /** Plaintext token — encrypted immediately, never stored. */
  token: string;
  githubLogin: string | null;
  githubUserId: number | null;
  avatarUrl: string | null;
  scope?: string | null;
  expiresAt?: number | null;
}

/**
 * Upsert an org-GitHub connection.
 *
 * The token is encrypted with `encryptCredential` before being stored.
 * Sets `last_validated_at` to now (since the caller first calls `validateToken`
 * and then `upsertOrgCredential`).
 *
 * WHERE org_id = ? (via UNIQUE index + conditional UPDATE/INSERT).
 */
export function upsertOrgCredential(
  input: UpsertOrgCredentialInput,
): OrgGithubCredentialRow {
  const db = getDb();
  const now = Date.now();
  const encryptedToken = encryptCredential(input.token);

  const existing = getOrgCredential(db.$raw, input.orgId);

  if (existing) {
    db.$raw
      .prepare(
        `UPDATE org_github_credentials SET
           auth_kind = ?,
           encrypted_token = ?,
           github_login = ?,
           github_user_id = ?,
           avatar_url = ?,
           scope = ?,
           expires_at = ?,
           last_validated_at = ?,
           updated_at = ?
         WHERE org_id = ?`,
      )
      .run(
        input.authKind,
        encryptedToken,
        input.githubLogin,
        input.githubUserId,
        input.avatarUrl,
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
        input.orgId, // WHERE org_id = ? — isolation anchor
      );
  } else {
    db.$raw
      .prepare(
        `INSERT INTO org_github_credentials (
           id, org_id, auth_kind, encrypted_token,
           github_login, github_user_id, avatar_url,
           scope, expires_at, last_validated_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `orgghc-${randomUUID()}`,
        input.orgId,
        input.authKind,
        encryptedToken,
        input.githubLogin,
        input.githubUserId,
        input.avatarUrl,
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
        now,
      );
  }

  const updated = getOrgCredential(db.$raw, input.orgId);
  if (!updated) {
    throw new Error("upsertOrgCredential: row missing after insert/update");
  }
  return updated;
}

// ─── Get (encrypted — no plaintext) ────────────────────────────────

/**
 * Internal getter: returns the complete row (encrypted_token NOT
 * decrypted) or null.
 *
 * NOT for API responses or UI panels — only for:
 *   - `decryptOrgToken` (needs encrypted_token to decrypt).
 *   - `upsertOrgCredential` (UPDATE/INSERT path, needs the existing row).
 *
 * Accepts `db.$raw` (better-sqlite3 Database) as a parameter so
 * callers can reuse the same connection without calling getDb()
 * multiple times.
 *
 * WHERE org_id = ? — isolation anchor.
 */
export function getOrgCredential(
  raw: import("better-sqlite3").Database,
  orgId: string,
): OrgGithubCredentialRow | null {
  const row = raw
    .prepare(
      `SELECT * FROM org_github_credentials WHERE org_id = ? LIMIT 1`,
    )
    .get(orgId) as OrgGithubCredentialRow | undefined;
  return row ?? null;
}

/**
 * Public-safe getter: returns metadata WITHOUT `encrypted_token`.
 *
 * For status routes, UI panels and all callers that need ONLY metadata
 * (connected status, github_login, last_validated_at, …).
 * `encrypted_token` is NOT included in the result.
 *
 * WHERE org_id = ? — isolation anchor.
 */
export function getOrgCredentialMeta(
  orgId: string,
): OrgGithubCredentialMeta | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT id, org_id, auth_kind,
              github_login, github_user_id, avatar_url,
              scope, expires_at, last_validated_at,
              created_at, updated_at
       FROM org_github_credentials
       WHERE org_id = ?
       LIMIT 1`,
    )
    .get(orgId) as OrgGithubCredentialMeta | undefined;
  return row ?? null;
}

// ─── N8 audit helpers ─────────────────────────────────────────

/**
 * Computes the N10 content_hash for a token-use audit row.
 * Fields: org_id, purpose, ts — NO token value.
 */
function computeTokenUseHash(row: {
  org_id: string;
  purpose: string;
  ts: number;
}): string {
  try {
    return createHash("sha256")
      .update(canonicalJSON({ org_id: row.org_id, purpose: row.purpose, ts: row.ts }), "utf8")
      .digest("hex");
  } catch {
    return createHash("sha256")
      .update(JSON.stringify(row), "utf8")
      .digest("hex");
  }
}

/**
 * Writes a best-effort N8 audit row to `org_github_token_use_audit`
 * (Migration 0106) when `decryptOrgToken` is called for a real GitHub
 * call.
 *
 * Best-effort: never throws — a failed audit write must NOT block the
 * real GitHub call.
 * N8 observability: errors are made visible as console.warn.
 * NO token value in the audit (D5 / SECURITY MANDATE).
 * N10: content_hash over canonicalJSON.
 */
function writeTokenUseAuditRow(orgId: string, purpose: string): void {
  try {
    const db = getDb();
    const ts = Date.now();
    const id = `oghtua-${randomUUID()}`;
    const content_hash = computeTokenUseHash({ org_id: orgId, purpose, ts });
    db.$raw
      .prepare(
        `INSERT INTO org_github_token_use_audit
           (id, org_id, purpose, ts, content_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, orgId, purpose, ts, content_hash);
  } catch (err) {
    // Best-effort — visible for N8 observability, but never blocking.
    // eslint-disable-next-line no-console
    console.warn("[org-github-audit] token-use audit write failed:", err);
  }
}

// ─── Decrypt (plaintext only for internal API calls) ─────────────────────

/**
 * Decrypts the token for a live GitHub API call.
 *
 * Writes a best-effort N8 audit row (org_id, purpose, ts, content_hash)
 * to `org_github_token_use_audit` (Migration 0106). NO token value in the audit.
 *
 * NEVER return it in an HTTP response.
 * NEVER write it to logs.
 *
 * @param orgId   Org ID (N9 isolation anchor).
 * @param purpose Short purpose description for the audit row (e.g. 'list-repos',
 *                'token-resolver'). Default: 'unspecified'.
 *
 * WHERE org_id = ? — isolation anchor.
 */
export function decryptOrgToken(orgId: string, purpose = "unspecified"): string | null {
  const db = getDb();
  const row = getOrgCredential(db.$raw, orgId);
  if (!row) return null;
  const plaintext = decryptCredential(row.encrypted_token);
  // N8: write the audit row AFTER the token has been successfully decrypted.
  // Only when we actually return a token (not null).
  if (plaintext !== null) {
    writeTokenUseAuditRow(orgId, purpose);
  }
  return plaintext;
}

// ─── Delete ───────────────────────────────────────────────────────────

/**
 * Deletes the org-GitHub connection.
 *
 * WHERE org_id = ? — isolation anchor.
 * Returns true if a row was deleted, false if no
 * connection existed.
 */
export function deleteOrgCredential(orgId: string): boolean {
  const db = getDb();
  const res = db.$raw
    .prepare(
      `DELETE FROM org_github_credentials WHERE org_id = ?`,
    )
    .run(orgId);
  return res.changes > 0;
}
