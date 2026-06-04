/**
 * Share-Tokens (Phase ORG+2 — 2026-04-28).
 *
 * Public-read tokens for external stakeholders (e.g. Alex @ Demo PV
 * sees a demo fitness PDF without login). Single-use-per-token NOT required;
 * multi-view token with expiry + optional max-views cap.
 *
 * Token format: `lzy_share_<43-base64url-chars>` (32 random bytes).
 * Storage: SHA-256 hash, NEVER plaintext.
 *
 * Public URL: `/share/<raw-token>` → reads the file (auth-free).
 * Middleware must configure `/share/*` and `/api/share/*` as a PUBLIC path.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const shareTokens = sqliteTable(
  "share_tokens",
  {
    id: text("id").primaryKey(),
    /** SHA-256 hex (token). */
    tokenHash: text("token_hash").notNull().unique(),
    /** Soft-FK auf cloud_artifacts.id. */
    artifactId: text("artifact_id").notNull(),
    /** Workspace-Bezug für Audit-Filterung. */
    workspaceId: text("workspace_id").notNull(),
    /** Wer hat den Link erstellt. */
    createdByUserId: text("created_by_user_id"),
    /** Optional: bcrypt-style hashed password. Null = kein Password. */
    passwordHash: text("password_hash"),
    /** Hard-Expiry timestamp_ms. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Max-Views; null = unbegrenzt. */
    maxViews: integer("max_views"),
    /** Counter inkrementiert pro Use. */
    currentViews: integer("current_views").notNull().default(0),
    /** Manuelle Revocation. */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedByUserId: text("revoked_by_user_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastViewedAt: integer("last_viewed_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    byArtifact: index("idx_share_artifact").on(table.artifactId),
    byExpires: index("idx_share_expires").on(table.expiresAt),
    byWorkspace: index("idx_share_workspace").on(table.workspaceId),
  }),
);

export type ShareTokenRow = typeof shareTokens.$inferSelect;
export type ShareTokenInsert = typeof shareTokens.$inferInsert;
