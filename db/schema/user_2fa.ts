/**
 * 2FA schema (Sprint 3, 2026-04-30).
 *
 * - user_2fa_recovery: 10 single-use codes per user, argon2id-hashed.
 * - auth_2fa_pending: 5-min pre-session token after magic-link step 1.
 *
 * Fields in users (totp_secret_ciphertext, totp_enabled_at, etc.) are
 * added via migration 0043 — they are NOT mirrored in db/schema/users.ts
 * to avoid Drizzle schema drift. Instead, access is
 * via raw SQL in lib/auth/2fa/repo.ts.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const user2faRecovery = sqliteTable(
  'user_2fa_recovery',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    usedAt: integer('used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    byUser: index('idx_user_2fa_recovery_user').on(t.userId),
    byUnused: index('idx_user_2fa_recovery_unused').on(t.userId, t.usedAt),
  }),
);

export const auth2faPending = sqliteTable(
  'auth_2fa_pending',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    /** 'magic-link' | 'master-code' */
    step1Method: text('step1_method').notNull(),
    expiresAt: integer('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    byUser: index('idx_auth_2fa_pending_user').on(t.userId),
    byExpiry: index('idx_auth_2fa_pending_expiry').on(t.expiresAt),
  }),
);

export type User2faRecoveryRow = typeof user2faRecovery.$inferSelect;
export type Auth2faPendingRow = typeof auth2faPending.$inferSelect;
