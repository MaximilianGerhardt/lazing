/**
 * Drizzle schema for the workspace cloud (Sprint X — 2026-04-27).
 *
 * Purpose: per-workspace file cloud — up/download, folder hierarchy,
 * AI generation in the cloud, surface cards in the chat. Works for
 * every workspace (dev-sprint, tap, demo-client, lazyos, example-product-c, ...) where
 * sensitive workspaces (sensitivity='high': demo-private, private, example-app-*)
 * are not writable in phase 1 WITHOUT encryption — the sensitivity
 * floor blocks upload API calls until phase 2 (AES-256-GCM at-rest).
 *
 * Three tables:
 *   - cloud_artifacts  → file metadata + storage path
 *   - cloud_folders    → folder hierarchy (parent_id-based + materialized path)
 *   - cloud_audit      → audit log (every read/write/delete)
 *
 * Storage:
 *   - Day-1: VPS disk via the VPS bridge ($HOME/.lazyos/cloud/<workspace>/<artifact-id>)
 *   - Day-N: S3 adapter (strategy pattern, same schema)
 *
 * Soft-delete: deleted_at IS NULL = active. The cleanup cron prunes after
 * workspace-configurable retention (default 90d).
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ */
/* cloud_artifacts                                                    */
/* ------------------------------------------------------------------ */

export const cloudArtifacts = sqliteTable(
  "cloud_artifacts",
  {
    /** ART-<ULID>. Primary Key. */
    id: text("id").primaryKey(),
    /** Workspace-ID (refs workspaces.id, soft-FK). */
    workspaceId: text("workspace_id").notNull(),
    /** Folder ID (refs cloud_folders.id, soft-FK). NULL = root of the workspace. */
    folderId: text("folder_id"),
    /** Display name incl. extension (e.g. "Tagesbericht-2026-04-27.pdf"). */
    filename: text("filename").notNull(),
    /** MIME type (e.g. "application/pdf", "image/png"). */
    mime: text("mime").notNull(),
    /** Size in bytes. */
    bytes: integer("bytes").notNull(),
    /** SHA-256 hex (integrity + dedup check). */
    sha256: text("sha256").notNull(),
    /** Storage path relative to the storage root (e.g. "demo-fitness/ART-XYZ"). */
    storagePath: text("storage_path").notNull(),
    /** 0 = unencrypted (phase 1), 1 = AES-256-GCM (phase 2). */
    encryptionVersion: integer("encryption_version").notNull().default(0),
    /** Page count for PDFs, NULL otherwise. */
    pages: integer("pages"),
    /** Thumbnail path, relative, NULL if none generated. */
    thumbnailPath: text("thumbnail_path"),
    /** Arbitrary JSON metadata (dimensions, EXIF, generator source, ...). */
    metadata: text("metadata"),
    /** "user" | "user:max" | "agent:<id>" | "anon-share-token:<id>". */
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    /** Soft-delete timestamp. NULL = active. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    byWorkspace: index("idx_cloud_artifacts_workspace").on(
      table.workspaceId,
      sql`${table.createdAt} DESC`,
    ),
    byFolder: index("idx_cloud_artifacts_folder").on(
      table.workspaceId,
      table.folderId,
      table.filename,
    ),
    bySha256: index("idx_cloud_artifacts_sha256").on(table.sha256),
    byDeleted: index("idx_cloud_artifacts_deleted").on(table.deletedAt),
  }),
);

export type CloudArtifactRow = typeof cloudArtifacts.$inferSelect;
export type CloudArtifactInsert = typeof cloudArtifacts.$inferInsert;

/* ------------------------------------------------------------------ */
/* cloud_folders                                                      */
/* ------------------------------------------------------------------ */

export const cloudFolders = sqliteTable(
  "cloud_folders",
  {
    /** FLD-<ULID>. Primary Key. */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** Parent folder ID. NULL = directly under the workspace root. */
    parentId: text("parent_id"),
    /** Display name (no slash, no backslash). */
    name: text("name").notNull(),
    /** Materialized path incl. leading slash (e.g. "/projects/2026-04"). */
    path: text("path").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    byWorkspacePath: index("idx_cloud_folders_path").on(
      table.workspaceId,
      table.path,
    ),
    byParent: index("idx_cloud_folders_parent").on(
      table.workspaceId,
      table.parentId,
    ),
  }),
);

export type CloudFolderRow = typeof cloudFolders.$inferSelect;
export type CloudFolderInsert = typeof cloudFolders.$inferInsert;

/* ------------------------------------------------------------------ */
/* cloud_audit                                                        */
/* ------------------------------------------------------------------ */

export const cloudAudit = sqliteTable(
  "cloud_audit",
  {
    /** AUD-<ULID>. Primary Key. */
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** Optional. NULL for folder actions or workspace-wide listings. */
    artifactId: text("artifact_id"),
    /** Optional. NULL for pure artifact actions. */
    folderId: text("folder_id"),
    /** "upload" | "download" | "preview" | "list" | "delete" | "move" | "rename" | "generate" | "thumbnail" */
    action: text("action").notNull(),
    /** "user" | "user:max" | "agent:<id>" | "anon-share-token:<id>" | "system". */
    actor: text("actor").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    /** Arbitrary JSON metadata (e.g. share-link-id, bytes-transferred). */
    metadata: text("metadata"),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byWorkspaceAt: index("idx_cloud_audit_workspace").on(
      table.workspaceId,
      sql`${table.at} DESC`,
    ),
    byArtifact: index("idx_cloud_audit_artifact").on(table.artifactId),
  }),
);

export type CloudAuditRow = typeof cloudAudit.$inferSelect;
export type CloudAuditInsert = typeof cloudAudit.$inferInsert;
