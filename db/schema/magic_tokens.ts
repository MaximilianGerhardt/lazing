/**
 * Drizzle schema for magic-link auth tokens (Phase ORG SP-1).
 *
 * Tokens are short-lived (default 30 min), single-use. We NEVER store
 * the plaintext token; only the SHA-256 hash. On verify we hash the plaintext
 * input from the browser and compare const-time against `token_hash`.
 *
 * GDPR:
 *   - email + ip + user_agent are personal → Art. 6(1)(f)
 *     legitimate interest (auth audit).
 *   - Soft-purge after `purge_after` (default consumed_at + 24h OR expires_at + 24h).
 *   - The phase-3 cron clears rows where `purge_after < now`.
 *
 * SP-3 will add the routes — the schema is here first.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const MAGIC_TOKEN_INTENTS = [
  "login",
  "invite-org",
  "invite-workspace",
] as const;
export type MagicTokenIntent = (typeof MAGIC_TOKEN_INTENTS)[number];

export const magicTokens = sqliteTable(
  "magic_tokens",
  {
    /** ULID. */
    id: text("id").primaryKey(),
    /** SHA-256 hex(token). NEVER store plaintext. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Lowercased email — recipient of the magic link. */
    email: text("email").notNull(),
    /** login | invite-org | invite-workspace */
    intent: text("intent").notNull(),
    intentOrgId: text("intent_org_id"),
    intentWorkspaceId: text("intent_workspace_id"),
    /** On invite: the pre-noted role for the membership. */
    intentRole: text("intent_role"),
    /** Who sent the link (only for invites). */
    issuedByUserId: text("issued_by_user_id"),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Single-use: NULL = not yet redeemed. */
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    consumedIp: text("consumed_ip"),
    consumedUserAgent: text("consumed_user_agent"),
    /** The cleanup cron prunes after this TS. */
    purgeAfter: integer("purge_after", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byEmail: index("idx_magic_email").on(table.email),
    byPurge: index("idx_magic_purge").on(table.purgeAfter),
  }),
);

export type MagicTokenRow = typeof magicTokens.$inferSelect;
export type MagicTokenInsert = typeof magicTokens.$inferInsert;
