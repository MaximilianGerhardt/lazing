/**
 * Drizzle schema for failed experiments (migration 0047).
 *
 * Context (real Pattern 9 "unlearning", 2026-05-01):
 *   Anne (Legaly-AI transcript) means by "to unlearn" a personal
 *   work attitude — discard assumptions, experiment more, try failed
 *   attempts AGAIN instead of archiving them. This table is the
 *   store for that.
 *
 * Read pattern: the weekly-retry-sniper runs Sunday 21:00, loads
 *   loadUnresolvedExperiments(maxAgeDays=14), cap=5/run.
 *
 * Write pattern: callers (sub-spawn failure handler, manual trigger
 *   from the UI, etc.) call recordFailedExperiment() in the fail-soft pattern.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const failedExperiments = sqliteTable(
  "failed_experiments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    hypothesis: text("hypothesis").notNull(),
    failureReason: text("failure_reason"),
    attemptedAt: integer("attempted_at").notNull(),
    modelUsed: text("model_used"),
    retryCount: integer("retry_count").notNull().default(0),
    lastRetryAt: integer("last_retry_at"),
    resolvedAt: integer("resolved_at"),
    resolutionNote: text("resolution_note"),
    workstreamId: text("workstream_id"),
    ticketId: text("ticket_id"),
  },
  (table) => ({
    byUnresolved: index("idx_failed_experiments_unresolved").on(
      table.resolvedAt,
      table.attemptedAt,
    ),
    byWorkspace: index("idx_failed_experiments_workspace").on(
      table.workspaceId,
      table.attemptedAt,
    ),
  }),
);

export type FailedExperimentRow = typeof failedExperiments.$inferSelect;
export type FailedExperimentInsert = typeof failedExperiments.$inferInsert;
