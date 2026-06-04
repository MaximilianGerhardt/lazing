/**
 * Drizzle schema for SOPs (Standard Operating Procedures) — SAR-2 · 2026-05-24.
 *
 * SOPs are reusable plan skeletons: each SOP consists of an
 * ordered list of `sop_steps` that `expandSopToPlanNodes` (lib/sop/executor.ts)
 * converts into the PlanNode structure from lib/plan-first/recursive-plan.ts.
 *
 * Scope:
 *   workspace_id = NULL   → global/template SOP (visible for all workspaces)
 *   workspace_id = <id>   → workspace-scoped SOP (private)
 *
 * N1:  never slice step_prompt_template (lint guard analogous to ledger fields).
 * N8:  SOPs are append-preferred; archived_at is soft-delete (no DELETE).
 * N10: content_hash = sha256(canonicalJson(row without hash)) — via lib/sop/registry.ts.
 *
 * The binding columns on `routines` are kept in routines.ts (Drizzle knows the
 * ALTER TABLE from the migration) — we do not re-export separate Drizzle
 * bindings for the ADD COLUMN changes (a breaking change would disturb the existing
 * routines types). The new columns are reachable via `routines.$inferSelect` once
 * migration 0099 is applied.
 */

import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// sops — plan-skeleton templates
// ---------------------------------------------------------------------------

export const sops = sqliteTable(
  "sops",
  {
    /** ULID with SOP- prefix for visual distinction in the UI. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * NULL = global/template SOP visible to all workspaces.
     * non-NULL = private to this workspace.
     */
    workspaceId: text("workspace_id"),
    /** Monotonic counter; bumped by registry.ts on update (old row archived first). */
    version: integer("version").notNull().default(1),
    /** 1 = seed/built-in (read-only for users); 0 = user-created. */
    builtIn: integer("built_in", { mode: "boolean" }).notNull().default(false),
    /** Soft-delete timestamp (NULL = active). N8: never hard-delete. */
    archivedAt: integer("archived_at"),
    /**
     * N10: sha256 over canonical JSON of this row (sans content_hash itself).
     * Computed by lib/sop/registry.ts. Bootstrap sentinel for seed rows
     * (format: "bootstrap:0099:<id>"), overwritten on first mutation.
     */
    contentHash: text("content_hash").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_sops_workspace").on(table.workspaceId),
    byBuiltIn: index("idx_sops_builtin").on(table.builtIn, table.archivedAt),
  }),
);

export type SopRow = typeof sops.$inferSelect;
export type SopInsert = typeof sops.$inferInsert;

// ---------------------------------------------------------------------------
// sop_steps — ordered steps within a SOP
// ---------------------------------------------------------------------------

export const sopSteps = sqliteTable(
  "sop_steps",
  {
    /** ULID with SOPS- prefix. */
    id: text("id").primaryKey(),
    /** FK → sops.id. ON DELETE CASCADE in SQL; enforced by registry on delete. */
    sopId: text("sop_id").notNull(),
    /** 0-based insertion order; ORDER BY step_index for deterministic expand. */
    stepIndex: integer("step_index").notNull(),
    /** Short action-oriented title (verbatim, N1). */
    title: text("title").notNull(),
    /**
     * N1: FULL prompt template text. NEVER sliced, NEVER truncated.
     * Template var: {{goal_prompt}} is replaced at dispatch time with the
     * routine's goal_prompt column value.
     *
     * ESLint N1-guard rule applies to this field (same as ledger-fields).
     */
    stepPromptTemplate: text("step_prompt_template").notNull(),
    /**
     * Subagent role (closed enum).
     * Recognised values: architect | coder | tester | reviewer | researcher | scribe
     * NULL = no preference; caller picks default.
     * Maps to PlanStep.subagentRole (orchestrate-plan.ts PlanSubagentRole).
     */
    subagentRole: text("subagent_role"),
    /**
     * JSON array of skill IDs — per-step skill hints.
     * e.g. '["skill:researcher", "skill:rag-retriever"]'
     */
    requiredSkillsJson: text("required_skills_json"),
    /**
     * JSON array of MCP tool names allowed for this specific step.
     * e.g. '["mcp__ruv-swarm__task_orchestrate"]'
     * NULL = inherit routine-level mcp_tool_allowlist_json.
     */
    mcpToolAllowlistJson: text("mcp_tool_allowlist_json"),
    /** 1 = may skip if upstream data unavailable; 0 = required. */
    optional: integer("optional", { mode: "boolean" }).notNull().default(false),
  },
  (table) => ({
    bySop: index("idx_sop_steps_sop").on(table.sopId, table.stepIndex),
    unique: unique("uq_sop_steps_sop_index").on(table.sopId, table.stepIndex),
  }),
);

export type SopStepRow = typeof sopSteps.$inferSelect;
export type SopStepInsert = typeof sopSteps.$inferInsert;

// ---------------------------------------------------------------------------
// SOP subagent roles — superset of PlanSubagentRole (adds researcher + scribe)
// ---------------------------------------------------------------------------

export const SOP_STEP_ROLES = [
  "architect",
  "coder",
  "tester",
  "reviewer",
  "researcher",
  "scribe",
] as const;
export type SopStepRole = (typeof SOP_STEP_ROLES)[number];
