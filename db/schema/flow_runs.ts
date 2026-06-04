/**
 * Drizzle schema for `flow_runs` (migration 0112 · Flow Studio P1).
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1.
 *
 * A flow_run is ONE execution of a flow_template. Substrate discipline
 * (N4): a flow_run creates ONE existing `workstreams` run and feeds
 * the compiled steps (lib/flow/compile.ts) into the existing
 * plan-executor/tier-orchestrator. NO new execution engine.
 *
 * `workstreamId` is the BRIDGE to the tier orchestrator (workstreams.id) — held
 * as a soft reference (NULL until the run is started; the wiring is P2).
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const flowRuns = sqliteTable(
  "flow_runs",
  {
    id: text("id").primaryKey(),
    /** which template ran (flow_templates.id). */
    flowId: text("flow_id"),
    /** ManifestCoord scope. */
    workspaceId: text("workspace_id"),
    /** Bridge to the existing tier orchestrator (workstreams.id), NULL until start. */
    workstreamId: text("workstream_id"),
    /** pending|running|done|failed|cancelled. */
    status: text("status").notNull().default("pending"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byFlow: index("idx_flow_runs_flow").on(table.flowId),
    byWorkspace: index("idx_flow_runs_ws").on(table.workspaceId),
    byWorkstream: index("idx_flow_runs_ws_stream").on(table.workstreamId),
  }),
);

export type FlowRunRow = typeof flowRuns.$inferSelect;
export type FlowRunInsert = typeof flowRuns.$inferInsert;

export const FLOW_RUN_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];
