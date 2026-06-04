/**
 * Drizzle schema for the workspace heartbeats table.
 *
 * Each row = one probe snapshot (= "heartbeat") of a workspace.
 * Append-only, just like the event log. The last 90 days are cleaned up
 * by a retention job (phase 6).
 *
 * Sensitivity floor: heartbeats are always `low` — they contain only
 * aggregate git counts (`uncommittedChanges`, `unpushedCommits`),
 * no filenames/contents.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceHeartbeats = sqliteTable(
  "workspace_heartbeats",
  {
    id: text("id").primaryKey(), // ULID
    workspaceId: text("workspace_id").notNull(),
    ts: integer("ts").notNull(), // ms epoch
    status: text("status").notNull(), // 'alive' | 'stale' | 'error'
    lagSec: integer("lag_sec").notNull(),
    probes: text("probes").notNull(), // JSON blob of ProbeResult
  },
  (table) => ({
    byWorkspaceTs: index("idx_heartbeats_workspace_ts").on(
      table.workspaceId,
      sql`${table.ts} DESC`,
    ),
  }),
);

export type WorkspaceHeartbeatRow = typeof workspaceHeartbeats.$inferSelect;
export type WorkspaceHeartbeatInsert = typeof workspaceHeartbeats.$inferInsert;
