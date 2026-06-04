// Plan-Repo — substrate writes for workstream_plan_steps.
//
// BACKPORT-03 von Lazing-V2 (2026-05-23 · Agent 3/8). Quelle:
// lazing-wt/realtime-orchestrator-v2/packages/runtime/src/store/plan-repo.ts.
//
// Hard-enforces:
//   - INV depth cap (0..MAX_SUBPLAN_DEPTH=3) at insert time
//   - N1 verbatim title + rationale (no .slice on insert)
//   - N9 coord_key validation (NOT NULL + ManifestCoord-shape)
//   - N10 content_hash stamp + verification

import { createHash } from 'node:crypto';

import { getDb } from '@/db/client';
import { ulid } from '@/lib/ulid';
import {
  workstreamPlanSteps,
  type WorkstreamPlanStepRow,
} from '@/db/schema/workstream_plan_steps';
import { and, asc, eq } from 'drizzle-orm';

import { MAX_SUBPLAN_DEPTH } from '@/lib/critic-loop/critic-loop';
import type {
  PlanStep,
  PlanSubagentRole,
  ProposedPlan,
} from '@/lib/plan-first/orchestrate-plan';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') +
    '}'
  );
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

function nowMs(): number {
  return Date.now();
}

export interface InsertPlanStepInput {
  readonly workstreamId: string;
  readonly planId: string;
  readonly step: PlanStep;
  readonly depth: number;
  readonly coordKey: string;
  readonly parentStepId?: string;
  /**
   * Optional explicit dependency step-ids (migration 0110). When the caller
   * KNOWS the dependency edges (e.g. a SOP→Plan dispatch with declared
   * ordering), it passes them here and they are persisted verbatim (N1) as a
   * JSON array in `depends_on`. When absent we write null — the conservative
   * default: no fabricated edges. The parallel executor treats null as
   * "no open dependencies → immediately ready".
   */
  readonly dependsOn?: readonly string[];
  /**
   * Optional explicit group membership id (migration 0110). When absent the
   * repo derives a conservative default: parentStepId for subplan steps, null
   * for root steps. Groups drive the "sort by membership after completion"
   * UI ordering; independent groups run in parallel.
   */
  readonly groupId?: string;
}

export interface InsertProposedPlanInput {
  readonly workstreamId: string;
  readonly plan: ProposedPlan;
  readonly depth: number;
  readonly coordKey: string;
  readonly parentStepId?: string;
}

/**
 * Insert a single plan step. Hard-blocks depth violations + missing
 * coord_key.
 */
export function insertPlanStep(input: InsertPlanStepInput): WorkstreamPlanStepRow {
  if (input.depth < 0 || input.depth > MAX_SUBPLAN_DEPTH) {
    throw new Error(
      `insertPlanStep: depth ${input.depth} out of range [0, ${MAX_SUBPLAN_DEPTH}]`,
    );
  }
  if (typeof input.coordKey !== 'string' || input.coordKey.length === 0) {
    throw new Error('insertPlanStep: coord_key required (N9 ManifestCoord)');
  }
  if (
    typeof input.step.title !== 'string' ||
    input.step.title.length === 0 ||
    typeof input.step.rationale !== 'string' ||
    input.step.rationale.length === 0
  ) {
    throw new Error('insertPlanStep: title + rationale required (N1 verbatim)');
  }
  const db = getDb();
  const id = input.step.id.startsWith('STEP-')
    ? input.step.id
    : `STEP-${ulid()}`;
  const ts = nowMs();
  const targetFilesJson = input.step.targetFiles
    ? JSON.stringify(input.step.targetFiles)
    : null;
  const expectedArtifactsJson = input.step.expectedArtifacts
    ? JSON.stringify(input.step.expectedArtifacts)
    : null;
  // R2-Gate: persist step-level tool allowlist verbatim (N1).
  // null = conservative default ['Read','Grep'] applied at runtime in plan-executor.
  const allowedToolsJson: string | null =
    input.step.allowedTools && input.step.allowedTools.length > 0
      ? JSON.stringify(input.step.allowedTools)
      : null;

  // Migration 0110 — dependency graph + subplan grouping.
  //   depends_on : a verbatim JSON array (N1) when the caller knows explicit
  //                edges, otherwise null (NO fabricated dependencies — the
  //                parallel executor treats null as "immediately ready").
  //   group_id   : conservative default = parentStepId (subplan steps belong
  //                to their parent), otherwise null (root steps = no group),
  //                unless the caller overrides explicitly.
  // Both fields are orchestration metadata and NOT part of the content_hash.
  const dependsOnJson: string | null =
    input.dependsOn && input.dependsOn.length > 0
      ? JSON.stringify(input.dependsOn)
      : null;
  const groupId: string | null =
    input.groupId ?? input.parentStepId ?? null;
  const payload = {
    workstreamId: input.workstreamId,
    planId: input.planId,
    parentStepId: input.parentStepId ?? null,
    stepIndex: input.step.index,
    title: input.step.title, // N1: verbatim
    rationale: input.step.rationale, // N1: verbatim
    subagentRole: input.step.subagentRole ?? null,
    targetFilesJson,
    expectedArtifactsJson,
    depth: input.depth,
    coordKey: input.coordKey,
    status: 'pending' as const,
    createdAt: ts,
    updatedAt: ts,
  };
  const contentHash = sha256(canonicalJson(payload));

  db.insert(workstreamPlanSteps)
    .values({
      id,
      ...payload,
      // allowed_tools is a runtime-gate field, NOT part of the content_hash payload.
      allowedTools: allowedToolsJson,
      // depends_on + group_id are orchestration metadata (migration 0110),
      // NOT part of the content_hash payload (like status + allowed_tools).
      dependsOn: dependsOnJson,
      groupId,
      contentHash,
    })
    .run();

  return {
    id,
    workstreamId: payload.workstreamId,
    planId: payload.planId,
    parentStepId: payload.parentStepId,
    stepIndex: payload.stepIndex,
    title: payload.title,
    rationale: payload.rationale,
    subagentRole: payload.subagentRole,
    targetFilesJson: payload.targetFilesJson,
    expectedArtifactsJson: payload.expectedArtifactsJson,
    depth: payload.depth,
    coordKey: payload.coordKey,
    status: payload.status,
    allowedTools: allowedToolsJson,
    dependsOn: dependsOnJson,
    groupId,
    contentHash,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  } satisfies WorkstreamPlanStepRow;
}

/**
 * Insert every step of a ProposedPlan in ONE transaction.
 * Returns the inserted rows in source-order.
 *
 * Critic fix B1 (2026-05-23): actually made transactional — the former
 * body ran a loop of standalone `.run()`s without a TX (the doc comment lied).
 * If `insertPlanStep` throws mid-plan, better-sqlite3 rolls back all already-
 * inserted steps → no half-persisted plan. Nests via savepoint
 * when a caller brackets multiple insertProposedPlan calls in an outer TX.
 */
export function insertProposedPlan(
  input: InsertProposedPlanInput,
): readonly WorkstreamPlanStepRow[] {
  const run = getDb().$raw.transaction((): WorkstreamPlanStepRow[] => {
    const rows: WorkstreamPlanStepRow[] = [];
    for (const step of input.plan.steps) {
      rows.push(
        insertPlanStep({
          workstreamId: input.workstreamId,
          planId: input.plan.id,
          step,
          depth: input.depth,
          coordKey: input.coordKey,
          ...(input.parentStepId ? { parentStepId: input.parentStepId } : {}),
        }),
      );
    }
    return rows;
  });
  return run();
}

/**
 * Update step status (pending → active → done/failed/cancelled).
 * Does NOT touch content_hash — status is a runtime-only field.
 */
export function setPlanStepStatus(
  stepId: string,
  status: 'pending' | 'active' | 'done' | 'failed' | 'cancelled',
): void {
  const db = getDb();
  db.update(workstreamPlanSteps)
    .set({ status, updatedAt: nowMs() })
    .where(eq(workstreamPlanSteps.id, stepId))
    .run();
}

/** Read all root-level (depth=0) steps of a workstream in order. */
export function listRootPlanSteps(
  workstreamId: string,
): readonly WorkstreamPlanStepRow[] {
  const db = getDb();
  return db
    .select()
    .from(workstreamPlanSteps)
    .where(
      and(
        eq(workstreamPlanSteps.workstreamId, workstreamId),
        eq(workstreamPlanSteps.depth, 0),
      ),
    )
    .orderBy(asc(workstreamPlanSteps.stepIndex))
    .all();
}

/** Read all sub-plan steps for a parent step in order. */
export function listSubplanSteps(
  parentStepId: string,
): readonly WorkstreamPlanStepRow[] {
  const db = getDb();
  return db
    .select()
    .from(workstreamPlanSteps)
    .where(eq(workstreamPlanSteps.parentStepId, parentStepId))
    .orderBy(asc(workstreamPlanSteps.stepIndex))
    .all();
}

/**
 * Subplan-promotion attempt — used by the operator-override route
 * (R-03-C). Returns null when depth cap is reached.
 */
export function promoteSubplan(input: {
  readonly workstreamId: string;
  readonly parentStep: PlanStep;
  readonly parentDepth: number;
  readonly subplan: ProposedPlan;
  readonly coordKey: string;
}): readonly WorkstreamPlanStepRow[] | null {
  const newDepth = input.parentDepth + 1;
  if (newDepth > MAX_SUBPLAN_DEPTH) return null;
  return insertProposedPlan({
    workstreamId: input.workstreamId,
    plan: input.subplan,
    depth: newDepth,
    coordKey: input.coordKey,
    parentStepId: input.parentStep.id,
  });
}

/** Read a single step by id. */
export function getPlanStep(stepId: string): WorkstreamPlanStepRow | null {
  const db = getDb();
  const rows = db
    .select()
    .from(workstreamPlanSteps)
    .where(eq(workstreamPlanSteps.id, stepId))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/**
 * Defense-in-depth: confirm a step row's content_hash matches its
 * persisted payload (N10 tamper-evidence). Returns true on match.
 */
export function verifyPlanStepHash(row: WorkstreamPlanStepRow): boolean {
  const payload = {
    workstreamId: row.workstreamId,
    planId: row.planId,
    parentStepId: row.parentStepId,
    stepIndex: row.stepIndex,
    title: row.title,
    rationale: row.rationale,
    subagentRole: row.subagentRole as PlanSubagentRole | null,
    targetFilesJson: row.targetFilesJson,
    expectedArtifactsJson: row.expectedArtifactsJson,
    depth: row.depth,
    coordKey: row.coordKey,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return sha256(canonicalJson(payload)) === row.contentHash;
}
