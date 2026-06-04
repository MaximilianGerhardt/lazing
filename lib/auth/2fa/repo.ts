/**
 * 2FA repo — DB access for users + user_2fa_recovery + auth_2fa_pending.
 *
 * users.totp_secret_ciphertext, .totp_enabled_at, .totp_last_used_at,
 * .totp_last_counter are added via migration 0043. The Drizzle schema
 * does not mirror them (avoids schema drift) — we use raw SQL.
 */

import { getDb } from '@/db/client';
import { auth2faPending, user2faRecovery } from '@/db/schema/user_2fa';
import { eq, and, isNull } from 'drizzle-orm';
import { ulid } from '@/lib/ulid';
import { hashRecoveryCode } from './totp';

interface UserTotpRow {
  totp_secret_ciphertext: string | null;
  totp_enabled_at: number | null;
  totp_last_used_at: number | null;
  totp_last_counter: number | null;
}

export function getUserTotp(userId: string): UserTotpRow | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT totp_secret_ciphertext, totp_enabled_at, totp_last_used_at, totp_last_counter
         FROM users WHERE id = ?`,
    )
    .get(userId) as UserTotpRow | undefined;
  return row ?? null;
}

export function setUserTotpSecret(args: {
  userId: string;
  ciphertext: string;
}): void {
  const db = getDb();
  db.$raw
    .prepare(
      `UPDATE users SET totp_secret_ciphertext = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(args.ciphertext, Date.now(), args.userId);
}

export function enableUserTotp(userId: string, counter: number): void {
  const db = getDb();
  const now = Date.now();
  db.$raw
    .prepare(
      `UPDATE users
          SET totp_enabled_at = ?,
              totp_last_used_at = ?,
              totp_last_counter = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(now, now, counter, now, userId);
}

export function recordTotpUse(userId: string, counter: number): void {
  const db = getDb();
  const now = Date.now();
  db.$raw
    .prepare(
      `UPDATE users
          SET totp_last_used_at = ?,
              totp_last_counter = ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(now, counter, now, userId);
}

export function disableUserTotp(userId: string): void {
  const db = getDb();
  db.$raw
    .prepare(
      `UPDATE users
          SET totp_secret_ciphertext = NULL,
              totp_enabled_at = NULL,
              totp_last_used_at = NULL,
              totp_last_counter = NULL,
              updated_at = ?
        WHERE id = ?`,
    )
    .run(Date.now(), userId);
  // Recovery-Codes mit-killen
  db.delete(user2faRecovery).where(eq(user2faRecovery.userId, userId)).run();
}

export function storeRecoveryCodes(userId: string, codes: string[]): void {
  const db = getDb();
  // Alte unbenutzte Codes invalidieren — neuer Setup-Run = neuer Pool.
  db.delete(user2faRecovery)
    .where(and(eq(user2faRecovery.userId, userId), isNull(user2faRecovery.usedAt)))
    .run();
  const now = Date.now();
  for (const code of codes) {
    db.insert(user2faRecovery)
      .values({
        id: ulid(),
        userId,
        codeHash: hashRecoveryCode(code),
        usedAt: null,
        createdAt: now,
      })
      .run();
  }
}

/**
 * Attempts to use a recovery code. On success, `used_at` is
 * set (single-use). Returns true if a code matched AND was still
 * unused.
 */
export function consumeRecoveryCode(userId: string, code: string): boolean {
  const hash = hashRecoveryCode(code);
  const db = getDb();
  const result = db.$raw
    .prepare(
      `UPDATE user_2fa_recovery
          SET used_at = ?
        WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
    )
    .run(Date.now(), userId, hash);
  return result.changes > 0;
}

export function countRemainingRecoveryCodes(userId: string): number {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT count(*) as n FROM user_2fa_recovery
        WHERE user_id = ? AND used_at IS NULL`,
    )
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// auth_2fa_pending — step-2 token after magic-link step 1
// ---------------------------------------------------------------------------

export const PENDING_TTL_MS = 5 * 60_000;

export function createPendingToken(args: {
  userId: string;
  step1Method: 'magic-link' | 'master-code';
}): string {
  const id = ulid();
  const db = getDb();
  const now = Date.now();
  db.insert(auth2faPending)
    .values({
      id,
      userId: args.userId,
      step1Method: args.step1Method,
      expiresAt: now + PENDING_TTL_MS,
      attempts: 0,
      createdAt: now,
    })
    .run();
  return id;
}

export function loadPendingToken(id: string): {
  userId: string;
  step1Method: string;
  expiresAt: number;
  attempts: number;
} | null {
  const db = getDb();
  const row = db
    .select()
    .from(auth2faPending)
    .where(eq(auth2faPending.id, id))
    .limit(1)
    .all();
  if (row.length === 0) return null;
  const r = row[0];
  if (Date.now() > r.expiresAt) return null;
  return {
    userId: r.userId,
    step1Method: r.step1Method,
    expiresAt: r.expiresAt,
    attempts: r.attempts,
  };
}

export function bumpPendingAttempts(id: string): number {
  const db = getDb();
  const now = Date.now();
  const result = db.$raw
    .prepare(
      `UPDATE auth_2fa_pending SET attempts = attempts + 1 WHERE id = ?`,
    )
    .run(id);
  if (result.changes === 0) return -1;
  const row = db
    .select({ attempts: auth2faPending.attempts })
    .from(auth2faPending)
    .where(eq(auth2faPending.id, id))
    .limit(1)
    .all();
  return row[0]?.attempts ?? -1;
}

export function deletePendingToken(id: string): void {
  const db = getDb();
  db.delete(auth2faPending).where(eq(auth2faPending.id, id)).run();
}

/** Cleanup-Hook (z.B. systemd-timer) — alte abgelaufene Pending-Tokens. */
export function purgeExpiredPending(): number {
  const db = getDb();
  const result = db.$raw
    .prepare(`DELETE FROM auth_2fa_pending WHERE expires_at < ?`)
    .run(Date.now());
  return result.changes;
}
