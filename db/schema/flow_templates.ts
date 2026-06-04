/**
 * Drizzle schema for `flow_templates` (migration 0112 · Flow Studio P1).
 *
 * Source: docs/plans/2026-05-27_flow-studio-architecture.md §1.
 *
 * A flow_template is the reusable "standard": a composed
 * multi-step pipeline (nodes like n8n/make), one skill per step + optionally
 * a tool/MCP/API. `graph_json` holds nodes+edges (for visualization in P3 +
 * the execution DAG); the normalized steps live in `flow_steps`.
 *
 * Owner decision §7.4: a flow ≠ necessarily a SOP. `sopId` is an OPTIONAL
 * soft-FK on sops.id (a flow CAN be stored as a SOP) — deliberately
 * NOT a real Drizzle `references()` (analogous to githubRepoId in
 * workspace_fs_roots.ts: the target may be missing / global).
 *
 * Scope (workspaceId/orgId) is ManifestCoord-analogous (N9). NULL = global/
 * template flow, visible across workspaces.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const flowTemplates = sqliteTable(
  "flow_templates",
  {
    id: text("id").primaryKey(),
    /** ManifestCoord scope: NULL = global/template flow. */
    workspaceId: text("workspace_id"),
    orgId: text("org_id"),
    name: text("name").notNull(),
    description: text("description"),
    /** Optional soft-FK on sops.id (a flow CAN be a SOP, NULL allowed). */
    sopId: text("sop_id"),
    /** Nodes+edges as JSON (visualization P3 + execution DAG). */
    graphJson: text("graph_json").notNull(),
    /** Slice 2 (2026-06-03): Parameter-Definitionen (JSON-Array). NULL = unparametrisiert. */
    paramsJson: text("params_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_flow_templates_ws").on(table.workspaceId),
  }),
);

export type FlowTemplateRow = typeof flowTemplates.$inferSelect;
export type FlowTemplateInsert = typeof flowTemplates.$inferInsert;
