/**
 * Workspace encryption keys (Phase ORG+1 — 2026-04-28).
 *
 * One data-encryption key (DEK) per workspace, wrapped with the
 * master KEK from env. We NEVER store the plaintext DEK; only the
 * wrapped form. On encrypt/decrypt we unwrap the DEK on-demand
 * and cache it in-memory per process.
 *
 * Format `wrappedDek`: base64url(`<nonce-12><tag-16><ciphertext-32>`)
 *   where ciphertext = AES-256-GCM-Encrypt(KEK, DEK).
 *
 * Rotation: SP-N. Today key_version=1 static.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceKeys = sqliteTable(
  "workspace_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** base64url(nonce|tag|ciphertext) — DEK wrapped mit Master-KEK. */
    wrappedDek: text("wrapped_dek").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    byWorkspace: index("idx_wskeys_workspace").on(table.workspaceId),
  }),
);

export type WorkspaceKeyRow = typeof workspaceKeys.$inferSelect;
export type WorkspaceKeyInsert = typeof workspaceKeys.$inferInsert;
