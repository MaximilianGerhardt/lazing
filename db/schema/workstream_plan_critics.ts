/**
 * Drizzle schema for `workstream_plan_critics` (BACKPORT-03 · 2026-05-23).
 *
 * One row per critic-round emission. INV-16 (max 2 fix-iter) means:
 * max 3 rows per plan_step_id (iter=0 initial + iter=1 + iter=2).
 *
 * Source: Lazing-V2 packages/runtime/src/store/migrations/011-recursive-plans.ts.
 *
 * Discipline:
 *   - N1: comments_json is persisted VERBATIM (no .slice).
 *   - N8: superseded_at as a soft-mark — no DELETE; preserve full critic history.
 *   - N10: content_hash = sha256(canonicalJson(row sans hash)).
 *   - INV-19: coord_key mirrors 1:1 the coder-lane coord.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workstreamPlanCritics = sqliteTable(
  'workstream_plan_critics',
  {
    id: text('id').primaryKey(),
    planStepId: text('plan_step_id').notNull(),
    /** 0 = first critic round; 1+2 = fix iterations (INV-16 cap at 2). */
    iteration: integer('iteration').notNull().default(0),
    /** Closed enum: pass|conditional|fail|superseded. */
    verdict: text('verdict').notNull(),
    /** N1: ReadonlyArray<{role,text,severity}> verbatim. */
    commentsJson: text('comments_json').notNull().default('[]'),
    /** Closed enum: critic|cross-roast|operator. */
    criticRole: text('critic_role').notNull().default('critic'),
    /** INV-19: same coord as coder lane. */
    coordKey: text('coord_key').notNull(),
    workstreamId: text('workstream_id'),
    contentHash: text('content_hash').notNull(),
    /** N8: soft-mark when a later iter replaces this row. */
    supersededAt: integer('superseded_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    byStep: index('idx_plan_critics_step').on(table.planStepId, table.iteration),
    byVerdict: index('idx_plan_critics_verdict').on(table.verdict),
    byCoord: index('idx_plan_critics_coord').on(table.coordKey),
  }),
);

export type WorkstreamPlanCriticRow = typeof workstreamPlanCritics.$inferSelect;
export type WorkstreamPlanCriticInsert = typeof workstreamPlanCritics.$inferInsert;

/** Closed verdict enum. */
export const CRITIC_VERDICTS = [
  'pass',
  'conditional',
  'fail',
  'superseded',
] as const;
export type CriticVerdict = (typeof CRITIC_VERDICTS)[number];

/** Closed critic-role enum. */
export const CRITIC_ROLES = ['critic', 'cross-roast', 'operator'] as const;
export type CriticRoleName = (typeof CRITIC_ROLES)[number];
