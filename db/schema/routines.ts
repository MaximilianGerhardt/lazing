/**
 * Drizzle schema for the routines engine (Sprint 2 · Stream E).
 *
 * Routines are proactive, declarative auto-runs. Each row is a
 * YAML-configured playbook that runs either by cron expression, by
 * event trigger, or manually. On execution, `collect_context`
 * commands are fired sequentially against the workspaces; the result is
 * dispatched onward via the `delivery` mode (stdout, memory_write via event,
 * ticket_create, push_send, decision_request).
 *
 * Architecture port from:
 *   `<install-dir>/example-tool/scripts/lifeos-routine-runner.ts`
 *
 * Differences from example-tool:
 *   - routines are DB-persistent instead of file-based (YAML file → YAML string
 *     in the `yamlConfig` column). Allows toggle/edit via the UI without a shell.
 *   - Delivery modes extended with push_send + decision_request (both
 *     write events to the lazyOS log, the latter additionally emits a push).
 *   - Cron + event trigger: `triggerMode` decides whether `cronExpr` or
 *     `eventMatch` is evaluated. One MUST be set (Zod validation).
 *
 * Retention:
 *   - `routines`: no auto-delete.
 *   - `routine_runs`: retention 90 days (phase 6 cleanup job — not Sprint 2).
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// routines
// ---------------------------------------------------------------------------

export const routines = sqliteTable(
  "routines",
  {
    /** ULID — aber mit `RTN-` Präfix zur optischen Unterscheidung in der UI. */
    id: text("id").primaryKey(),
    /** Kurzname, muss innerhalb eines Workspaces eindeutig sein (App-Ebene). */
    name: text("name").notNull(),
    /** Workspace-Zuordnung — bestimmt Sichtbarkeit + Sensitivity-Floor. */
    workspaceId: text("workspace_id").notNull(),
    /**
     * YAML configuration as a string. Parsed + validated via
     * `lib/routines/types.ts` → `RoutineConfigSchema`. Single source of truth
     * for commands, delivery, synthesis agent, etc.
     */
    yamlConfig: text("yaml_config").notNull(),
    /** 'cron' | 'manual' | 'event'. */
    triggerMode: text("trigger_mode").notNull().default("manual"),
    /** Standard cron expression (5 fields). Only when triggerMode='cron'. */
    cronExpr: text("cron_expr"),
    /**
     * Event-match predicate as a JSON blob: `{ eventType, entityType?, payloadMatch? }`.
     * Only when triggerMode='event'. Empty → never runs automatically.
     */
    eventMatch: text("event_match"),
    lastRunAt: integer("last_run_at"),
    nextRunAt: integer("next_run_at"),
    /** 1 = active, 0 = disabled (stays in DB, but does not run). */
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // SAR-2 / migration 0099: SOP binding + plan-dispatch columns.
    /** Optional FK to sops.id. NULL = shell-only routine (backward-compatible). */
    sopId: text("sop_id"),
    /** Free-text goal threaded through SOP steps at dispatch time. */
    goalPrompt: text("goal_prompt"),
    /** JSON map { "<stepIndex>": "<skillId>" } — per-step skill overrides. */
    skillBindingsJson: text("skill_bindings_json"),
    /** JSON array of MCP tool names — routine-level allow-list override. */
    mcpToolAllowlistJson: text("mcp_tool_allowlist_json"),
    /** 'shell' (default) | 'plan-dispatch' (SAR-3 bridge). */
    actionKind: text("action_kind").notNull().default("shell"),
  },
  (table) => ({
    byWorkspace: index("idx_routines_workspace").on(table.workspaceId),
    byActive: index("idx_routines_active").on(table.active),
    /** For the tick loop: quickly find all due cron routines. */
    byNextRun: index("idx_routines_next_run").on(
      table.active,
      sql`${table.nextRunAt} ASC`,
    ),
  }),
);

export type RoutineRow = typeof routines.$inferSelect;
export type RoutineInsert = typeof routines.$inferInsert;

// ---------------------------------------------------------------------------
// routine_runs — execution history
// ---------------------------------------------------------------------------

export const routineRuns = sqliteTable(
  "routine_runs",
  {
    id: text("id").primaryKey(), // ULID mit `RNR-` Präfix
    routineId: text("routine_id").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    /** 'success' | 'failure' | 'partial' | 'running' */
    status: text("status").notNull(),
    /** Rendered Markdown-Output (kann groß sein; später Retention). */
    output: text("output"),
    error: text("error"),
    /** Optional: ID des erzeugten Events/Tickets/Push-Delivery-Logs. */
    deliveryRef: text("delivery_ref"),
  },
  (table) => ({
    byRoutineTime: index("idx_runs_routine_started").on(
      table.routineId,
      sql`${table.startedAt} DESC`,
    ),
  }),
);

export type RoutineRunRow = typeof routineRuns.$inferSelect;
export type RoutineRunInsert = typeof routineRuns.$inferInsert;
