/**
 * Drizzle schema for the `schema_version` migration registry
 * (see db/migrations/0021_schema_version.sql).
 *
 * Read by /api/diagnostics, written by the auto-migrator at boot
 * (db/client.ts).
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const schemaVersion = sqliteTable(
  "schema_version",
  {
    version: integer("version").primaryKey(),
    filename: text("filename").notNull(),
    schemaHash: text("schema_hash"),
    appliedAt: integer("applied_at").notNull(),
  },
  (table) => ({
    byApplied: index("idx_schema_version_applied_at").on(
      sql`${table.appliedAt} DESC`,
    ),
  }),
);

export type SchemaVersionRow = typeof schemaVersion.$inferSelect;
