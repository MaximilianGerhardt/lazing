/**
 * Drizzle schema for `flow_steps` (migration 0112 · Flow Studio P1).
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1.
 *
 * A flow_step is a node in the flow. Per step:
 *   - `skill`        : role-skill-map key (see lib/agents/role-skill-map.ts).
 *   - `toolKind`     : null | 'connector' | 'mcp' | 'engine'.
 *   - `connectorId`  : OPTIONAL soft-FK on connectors (imagegen2/Higgsfield/
 *                      Heygen/…) — NOT a real FK (the catalog may be missing).
 *   - `configJson`   : step parameters (JSON).
 *   - `dependsOnJson`: DAG edges — JSON array of flow_steps.id (predecessors).
 *
 * `idx` holds the stable source order (layout tie-break + sequential
 * fallback on a cycle). The pure execution order arises from dependsOnJson
 * (topological) — see lib/flow/compile.ts.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const flowSteps = sqliteTable(
  "flow_steps",
  {
    id: text("id").primaryKey(),
    /** belongs to flow_templates.id. */
    flowId: text("flow_id").notNull(),
    /** Stable source order (layout / tie-break / sequential fallback). */
    idx: integer("idx").notNull().default(0),
    label: text("label"),
    /** role-skill-map key (build/copy/design/…). */
    skill: text("skill"),
    /** null | 'connector' | 'mcp' | 'engine'. */
    toolKind: text("tool_kind"),
    /** Optional soft-FK on connectors.id (NULL allowed). */
    connectorId: text("connector_id"),
    /** Step parameters as JSON. */
    configJson: text("config_json"),
    /** DAG edges: JSON array of flow_steps.id (predecessors). */
    dependsOnJson: text("depends_on_json"),
    /** Slice 2 (2026-06-03): {inputs:{...},outputs:[...]} with {{param.*}} templates. */
    ioJson: text("io_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byFlow: index("idx_flow_steps_flow").on(table.flowId),
  }),
);

export type FlowStepRow = typeof flowSteps.$inferSelect;
export type FlowStepInsert = typeof flowSteps.$inferInsert;
