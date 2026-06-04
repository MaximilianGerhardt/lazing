/**
 * lib/flow/repetition-detect.ts — Self-Learning workflow recording, slice 1.
 *
 * Design: docs/plans/2026-06-03_self-learning-workflow-recording-design.md (c)/(e).
 *
 * The ONLY new server mechanism of slice 1: at the run-completion hook
 * (lib/workstreams/plan-executor.ts), `detectWorkflowRepetition` recognizes whether the
 * just-completed run already ran structurally several times this way — and
 * decides (deterministically) whether the AI should suggest saving it as a
 * reusable workflow. „Self Learning … Repetitors
 * erkennen" (owner).
 *
 * Discipline:
 *   - N6: purely deterministic (signature + event count + score). No LLM.
 *   - N8: append-only — each run writes ONE `workflow.structure_seen` event;
 *     the counter is derivable from it (no in-place UPDATE). "Why suggested?"
 *     stays answerable.
 *   - N9: strictly workspace-isolated (segment_id = workspaceId; only this scope
 *     is counted).
 *   - Reads the root plan steps raw from the better-sqlite3 handle (same discipline
 *     as from-workstream.ts) → in-memory testable.
 *   - NEVER auto-save, NEVER auto-run: the function only DECIDES (`suggest`); the
 *     surfacing/saving stays owner-gated (plan-executor emits a card,
 *     saving runs via the existing /api/flow/from-workstream path).
 *   - fail-soft at the caller (its own try/catch in the plan-executor).
 *
 * Slice 1 limits (deliberate, see design (e)): NO parametrization, NO
 * structure_sig/seen_count column (slice 2). `alreadyTemplated` is therefore
 * always false in slice 1 (no column lookup available); `outcomeFailed` is
 * derived best-effort from the most recent step status.
 */

import { ulid } from '@/lib/ulid';
import { parseFlowAnnotation } from './from-workstream';
import {
  computeStructureSignature,
  isToolStep,
  scoreRepetition,
  type SignatureStep,
} from './structure-signature';

type RawDb = import('better-sqlite3').Database;

const EVENT_TYPE = 'workflow.structure_seen';
const ENTITY_TYPE = 'workflow_structure';

interface RawPlanStepRow {
  readonly id: string;
  readonly step_index: number;
  readonly rationale: string | null;
  readonly subagent_role: string | null;
  readonly status: string | null;
}

export interface DetectRepetitionInput {
  /** ManifestCoord scope (N9). */
  readonly workspaceId: string;
  readonly workstreamId: string;
}

export interface DetectRepetitionResult {
  /** Should the AI suggest "Save as workflow?" */
  readonly suggest: boolean;
  /** Completions of this signature in the workspace INCLUDING this run. */
  readonly seenCount: number;
  /** Score of the heuristic. */
  readonly score: number;
  /** The canonical structure signature (sha256:…). */
  readonly signature: string;
  /** Number of steps. */
  readonly stepCount: number;
  /** Human-readable short summary of the step chain (for the card). */
  readonly stepSummary: string;
}

/**
 * Builds a compact "A → B → C" description from the step descriptors.
 * Prefers connector, then skill, then a generic label.
 */
function buildStepSummary(steps: readonly SignatureStep[]): string {
  const parts = steps.map((s) => s.connectorId ?? s.skill ?? 'schritt');
  // N1: do not slice/truncate — the full chain is the statement.
  return parts.join(' → ');
}

/**
 * Detects repetition of the just-completed workstream + writes the
 * append-only audit event. Returns null if there is nothing to evaluate
 * (no root steps). Does NOT throw (defensive); the caller additionally wraps.
 */
export function detectWorkflowRepetition(
  raw: RawDb,
  input: DetectRepetitionInput,
): DetectRepetitionResult | null {
  const { workspaceId, workstreamId } = input;
  if (!workspaceId || !workstreamId) return null;

  // 1. Read root plan steps (depth=0), ordered — same source as the
  //    back-compiler from-workstream.ts.
  const rows = raw
    .prepare(
      `SELECT id, step_index, rationale, subagent_role, status
         FROM workstream_plan_steps
        WHERE workstream_id = ? AND depth = 0
        ORDER BY step_index ASC`,
    )
    .all(workstreamId) as RawPlanStepRow[];

  if (rows.length === 0) return null;

  // 2. Reconstruct step descriptors (annotation > role fallback).
  //    Slice 2b-1 (config capture): in parallel, record the config VALUES per step for
  //    the later auto-param extraction (label = skill, stable across
  //    runs of the same structure; configJson verbatim, N1).
  const configs: Array<{ label: string; config: string | null }> = [];
  const steps: SignatureStep[] = rows.map((r, i) => {
    const { annotation } = parseFlowAnnotation(r.rationale ?? '');
    const skill = annotation?.skill ?? (r.subagent_role ?? null);
    configs.push({ label: skill ?? `step-${i}`, config: annotation?.configJson ?? null });
    return {
      skill,
      toolKind: annotation?.toolKind ?? null,
      connectorId: annotation?.connectorId ?? null,
    };
  });

  const signature = computeStructureSignature(steps);
  const hasToolStep = steps.some(isToolStep);

  // 3. Count earlier completions of this signature in the workspace (N9: segment_id).
  const priorRow = raw
    .prepare(
      `SELECT COUNT(*) AS c
         FROM events
        WHERE segment_id = ? AND entity_id = ? AND event_type = ?`,
    )
    .get(workspaceId, signature, EVENT_TYPE) as { c: number } | undefined;
  const priorCount = priorRow?.c ?? 0;
  const seenCount = priorCount + 1; // incl. current run

  // 4. Outcome best-effort: counts as failed if NO step is 'done'
  //    and at least one is 'failed'/'error' (slice 1 — rough heuristic, fail-soft).
  const statuses = rows.map((r) => (r.status ?? '').toLowerCase());
  const anyFailed = statuses.some((s) => s === 'failed' || s === 'error');
  const anyDone = statuses.some((s) => s === 'done' || s === 'completed' || s === 'merged');
  const outcomeFailed = anyFailed && !anyDone;

  const scored = scoreRepetition({
    seenCount,
    stepCount: steps.length,
    hasToolStep,
    alreadyTemplated: false, // Slice 1: no structure_sig column (slice 2)
    outcomeFailed,
  });

  // 5. Write the append-only audit event (N8). Raw INSERT (testable, no
  //    broadcast needed — it is an internal counter/audit, not a UI event).
  try {
    raw
      .prepare(
        `INSERT INTO events
           (id, created_at, segment_id, entity_type, entity_id, event_type, actor, payload, sensitivity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `EVT-${ulid()}`,
        Date.now(),
        workspaceId,
        ENTITY_TYPE,
        signature,
        EVENT_TYPE,
        'system',
        JSON.stringify({
          seenCount,
          score: scored.score,
          suggest: scored.suggest,
          stepCount: steps.length,
          workstreamId,
          // 2b-1: config values for the auto-param diff (cap 8 KB as a guard;
          // omitted on overflow → auto-param accuracy drops,
          // reproduction stays). N1 verbatim.
          ...(JSON.stringify(configs).length <= 8192
            ? { configs }
            : { configsTruncated: true }),
        }),
        'low',
      );
  } catch {
    /* fail-soft: writing the audit event must never topple the detector */
  }

  return {
    suggest: scored.suggest,
    seenCount,
    score: scored.score,
    signature,
    stepCount: steps.length,
    stepSummary: buildStepSummary(steps),
  };
}
