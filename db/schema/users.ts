/**
 * Drizzle schema for users — multi-subject foundation (Phase ORG SP-1).
 *
 * Before Phase ORG: lazyOS was single-user with a hardcoded subject `user:max`.
 * Phase ORG introduces a first-class user concept. Magic-link auth (SP-3)
 * issues sessions that reference a `users.id` (ULID).
 *
 * GDPR:
 *   - Email is personal → Art. 6(1)(b) contract performance at login.
 *   - Soft-delete via `status='deleted'` + `deleted_at`. On soft-delete the email
 *     is hashed to `deleted-{id}@lazyos.local` so the audit trail
 *     is preserved but no PII is referenced anymore (Art. 17).
 *   - `onboarding_state` is a JSON blob; only UI state, no profile.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const USER_STATUSES = ["active", "suspended", "bounced", "deleted"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Phase MU.1 — Claude-MAX-plan binding per user.
 *
 *   'shared' (default): the user shares the system MAX plan (Max's token).
 *   'own':              the user has stored their own credentials.json.
 *   'none':             the user actively declined; spawns for this user
 *                       fail until they either accept shared
 *                       or couple their own plan.
 */
export const CLAUDE_MAX_STATUSES = ["shared", "own", "none"] as const;
export type ClaudeMaxStatus = (typeof CLAUDE_MAX_STATUSES)[number];

export const users = sqliteTable(
  "users",
  {
    /** ULID. Primary Key. */
    id: text("id").primaryKey(),
    /** Lowercased email. Unique. */
    email: text("email").notNull().unique(),
    /** When the magic link confirmed that the email works. */
    emailVerifiedAt: integer("email_verified_at", { mode: "timestamp_ms" }),
    /** Optional scrypt password hash (email+password login). NULL = magic-link only. */
    passwordHash: text("password_hash"),
    /** Display name. */
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    locale: text("locale").notNull().default("de-DE"),
    /** active | suspended | bounced | deleted. */
    status: text("status").notNull().default("active"),
    /** UI state per user (JSON). */
    onboardingState: text("onboarding_state"),
    onboardingCompletedAt: integer("onboarding_completed_at", {
      mode: "timestamp_ms",
    }),
    /**
     * Phase MU.1 — path to the encrypted-at-rest credentials.json.
     * NULL → the user uses the shared system token (see claude_max_status).
     */
    claudeMaxCredsPath: text("claude_max_creds_path"),
    /** 'shared' | 'own' | 'none' — see CLAUDE_MAX_STATUSES. */
    claudeMaxStatus: text("claude_max_status").notNull().default("shared"),
    /** Diagnostic field — display only. */
    claudeMaxEmail: text("claude_max_email"),
    claudeMaxUpdatedAt: integer("claude_max_updated_at", {
      mode: "timestamp_ms",
    }),
    /** DSGVO Soft-Delete. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byEmail: index("idx_users_email").on(table.email),
    byStatus: index("idx_users_status").on(table.status),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
