/**
 * Drizzle schema for `workstream_plan_steps` (BACKPORT-03 · 2026-05-23).
 *
 * One row per plan step of a ProposedPlan. depth=0 is root-level;
 * depth=1..3 are subplan recursion levels (MAX_SUBPLAN_DEPTH=3, enforced in TS
 * via lib/critic-loop/critic-loop.ts).
 *
 * Source: Lazing-V2 packages/runtime/src/store/migrations/011-recursive-plans.ts
 * — V2 extends an existing table; lazyos-stable creates it new here.
 *
 * Discipline:
 *   - N1: title + rationale are persisted VERBATIM (no .slice).
 *   - N9: coord_key is validated against ManifestCoord before insert.
 *   - N10: content_hash = sha256(canonicalJson(row sans hash)).
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workstreamPlanSteps = sqliteTable(
  'workstream_plan_steps',
  {
    id: text('id').primaryKey(),
    workstreamId: text('workstream_id').notNull(),
    planId: text('plan_id').notNull(),
    /** Nullable: subplan-Step trägt parent_step_id; root-Steps trägen NULL. */
    parentStepId: text('parent_step_id'),
    stepIndex: integer('step_index').notNull(),
    /** N1: verbatim from LLM/template. */
    title: text('title').notNull(),
    /** N1: verbatim from LLM/template. */
    rationale: text('rationale').notNull(),
    /** Closed enum: architect|coder|tester|reviewer (nullable for free-form). */
    subagentRole: text('subagent_role'),
    /** JSON array of 1-3 path hints. */
    targetFilesJson: text('target_files_json'),
    /** JSON array of 1-3 artifact keywords (HANDOFF-DOC §3). */
    expectedArtifactsJson: text('expected_artifacts_json'),
    /** 0..MAX_SUBPLAN_DEPTH (=3). Cap enforced in code. */
    depth: integer('depth').notNull().default(0),
    coordKey: text('coord_key').notNull(),
    /**
     * JSON array of tool names this step is allowed to request.
     * e.g. '["Read","Grep"]' or '["Read","Grep","Write","Edit"]'.
     * null = conservative default: ["Read","Grep"] enforced at runtime
     * in plan-executor.ts (N6: deterministic gate reads real step tools).
     * NOT included in content_hash (runtime metadata, like `status`).
     */
    allowedTools: text('allowed_tools'),
    /**
     * JSON array of step-ids this step depends on (migration 0110).
     * Empty/null → no open dependencies → step is immediately ready.
     * The parallel plan-executor builds a dependency graph from this field
     * (N6: deterministic ready-queue, no LLM) and a cycle → sequential fallback.
     * NOT part of content_hash (orchestration metadata, like `status`).
     */
    dependsOn: text('depends_on'),
    /**
     * Subplan-group / membership id (migration 0110).
     * Conservative default written by plan-repo: parent_step_id for subplan
     * steps, null for root steps. "Sort all subplans by membership after
     * completion" = group by group_id; independent groups run in parallel.
     * NOT part of content_hash (orchestration metadata, like `status`).
     */
    groupId: text('group_id'),
    /** Closed enum: pending|active|done|failed|cancelled. */
    status: text('status').notNull().default('pending'),
    contentHash: text('content_hash').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    byWs: index('idx_plan_steps_ws').on(
      table.workstreamId,
      table.depth,
      table.stepIndex,
    ),
    byPlan: index('idx_plan_steps_plan').on(table.planId, table.stepIndex),
    byParent: index('idx_plan_steps_parent').on(table.parentStepId),
    byCoord: index('idx_plan_steps_coord').on(table.coordKey),
    byHash: index('idx_plan_steps_hash').on(table.contentHash),
  }),
);

export type WorkstreamPlanStepRow = typeof workstreamPlanSteps.$inferSelect;
export type WorkstreamPlanStepInsert = typeof workstreamPlanSteps.$inferInsert;

export const PLAN_STEP_ROLES = [
  'architect',
  'coder',
  'tester',
  'reviewer',
] as const;
export type PlanStepRole = (typeof PLAN_STEP_ROLES)[number];

export const PLAN_STEP_STATUSES = [
  'pending',
  'active',
  'done',
  'failed',
  'cancelled',
] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];
