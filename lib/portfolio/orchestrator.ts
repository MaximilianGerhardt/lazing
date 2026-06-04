/**
 * Phase 2 W2.x — portfolio orchestrator (the WRITER to the read lens `spine.ts`)
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE IS
 * ────────────────────
 * `spine.ts` is a **read lens without a writer**: `loadPortfolioRunState`
 * expects a parent workstream (`mode='portfolio'`), one
 * child workstream per lane (`role='lane:<id>'`) and stage completions as
 * `workstream_decisions(decision_kind='route', rationale='portfolio-stage-
 * completed: <stage>')`. Until now NOBODY wrote these rows — so
 * `loadPortfolioRunState` always returned `null`.
 *
 * This module is the missing WRITER. It creates a REAL portfolio run
 * and advances stages — but ONLY when the stage's gate is green (N6
 * deterministic). After `createPortfolioRun` the spine sees the run
 * (`loadPortfolioRunState !== null`).
 *
 * SUBSTRATE DISCIPLINE (N4)
 * ───────────────────────
 * NO new table, NO swarm_runs/swarm_branches. A portfolio run is
 * fully represented in `workstreams` + `workstream_decisions` — exactly
 * the rows the spine reads back:
 *
 *   parent workstream            → workstreams.mode='portfolio', parent IS NULL
 *   per-lane child workstream    → parent_workstream_id=<parent>,
 *                                  role='lane:<laneId>'
 *   stage completion             → workstream_decisions(decision_kind='route',
 *                                  rationale='portfolio-stage-completed: <id>',
 *                                  actor='policy')
 *
 * GATE DISCIPLINE (the whole purpose of the 11-sequence)
 * ───────────────────────────────────────────────
 * `advanceStage` calls `canMergeStage(loadPortfolioRunState(...), stage)`.
 *   - red gates OR missing requires → NO advance, NO decision write.
 *   - stage N can NEVER advance before stage N-1 (requires-DAG, deterministic).
 *   - green → exactly ONE append-only decision row → stage counts as completed.
 *
 * Constraints mapping:
 *   N6  — gate validators are pure/deterministic; a red gate blocks hard.
 *   N8  — every stage completion writes a „why?" decision row (trace).
 *   N9  — every decision carries a ManifestCoord key (workspace/run).
 *   N10 — content_hash (sha256 over canonical JSON) per decision row;
 *         duplicate hash = idempotent (UNIQUE index, ON CONFLICT IGNORE).
 *
 * Interface shape: like `loadPortfolioRunState`, this module works directly
 * on the raw `better-sqlite3` handle (`db.$raw`). That keeps it synchronous,
 * deterministic and in-memory testable (same pattern as `spine.test.ts`).
 *
 * As of: 2026-05-29
 */

import { createHash } from 'node:crypto';

import type { Database as Sqlite } from 'better-sqlite3';

import { ulid } from '@/lib/ulid';

// Namespace import of the spine, so the reader (`loadPortfolioRunState`) is a
// SINGLE, overridable binding — the advance path MUST use the same reader
// that the GET route + tests see (single source of truth for the
// run state; also enables test doubles without a production special path).
import * as spine from './spine';
const { canMergeStage, nextMergeableStages } = spine;
import type {
  CanMergeStageResult,
  LaneId,
  MergeStageId,
  PortfolioRunState,
} from './types';
import { LANE_IDS } from './types';

// ───────────────────────────────────────────────────────────────────────────
// Constants — exactly the vocabulary that loadPortfolioRunState reads back.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The EXACT rationale prefix that `loadPortfolioRunState` matches
 * (`spine.ts`: `const prefix = 'portfolio-stage-completed: '`). Includes the
 * trailing space. Used verbatim — do NOT change without adjusting the reader
 * at the same time, otherwise the spine won't see the completion.
 */
export const STAGE_COMPLETED_PREFIX = 'portfolio-stage-completed: ';

/** workstreams.mode marker for the parent run. */
const PORTFOLIO_MODE = 'portfolio';

/** Decision kind the spine reads for stage completions (CHECK 0071). */
const STAGE_DECISION_KIND = 'route';

/** Actor of the stage-advance decision — the spine doesn't evaluate it, but N8/N5
 *  require that a deterministic policy advance is marked as 'policy'
 *  (no 'agent'/'user' masking of a machine decision). */
const STAGE_DECISION_ACTOR = 'policy';

// ───────────────────────────────────────────────────────────────────────────
// Helper functions
// ───────────────────────────────────────────────────────────────────────────

/** SHA-256 over a canonical JSON object (N10). Always 64 hex characters. */
function sha256hex(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Canonical ManifestCoord key (N9): "<workspaceId>/<runId>". */
function coordKey(workspaceId: string, runId: string): string {
  return `${workspaceId}/${runId}`;
}

/** Rationale text for a stage completion — exactly in the reader format. */
function stageCompletedRationale(stage: MergeStageId): string {
  return `${STAGE_COMPLETED_PREFIX}${stage}`;
}

/**
 * Normalizes the passed lane list to valid, unique LaneIds.
 * Empty/invalid list → all 7 canonical lanes (default full screen).
 */
function normalizeLanes(lanes: readonly string[] | undefined): LaneId[] {
  if (!Array.isArray(lanes) || lanes.length === 0) {
    return [...LANE_IDS];
  }
  const out: LaneId[] = [];
  const seen = new Set<string>();
  for (const l of lanes) {
    if (typeof l !== 'string') continue;
    if (!LANE_IDS.includes(l as LaneId)) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l as LaneId);
  }
  // If the list contained only garbage → default full screen instead of an empty run.
  return out.length > 0 ? out : [...LANE_IDS];
}

// ───────────────────────────────────────────────────────────────────────────
// 1. createPortfolioRun — der Writer, der den Run materialisiert.
// ───────────────────────────────────────────────────────────────────────────

export interface CreatePortfolioRunInput {
  workspaceId: string;
  /**
   * Which lanes the run carries. Empty/undefined → all 7 canonical lanes.
   * Invalid lane IDs are filtered out (deterministic, N6).
   */
  lanes?: readonly string[];
  /** Verbatim user intent (N1) — lands in the parent name + description. */
  intent?: string;
}

export interface CreatePortfolioRunResult {
  /** workstreams.id of the parent workstream (mode='portfolio'). */
  portfolioRunId: string;
  /** Per lane → child workstream ID. */
  laneWorkstreamIds: Record<string, string>;
  /** The normalized lanes that were actually created. */
  lanes: LaneId[];
}

/**
 * Creates a portfolio run as 1 parent + N child workstreams (N4).
 *
 *   parent → mode='portfolio', parent_workstream_id IS NULL, status='active'
 *   child  → parent_workstream_id=parent, role='lane:<laneId>', status='active'
 *
 * All inserts run in ONE transaction (atomic — either the whole run
 * exists or none). Deterministic, synchronous, in-memory testable.
 *
 * Returns the portfolioRunId + the child workstream IDs. After this call
 * `loadPortfolioRunState(db, workspaceId)` returns a REAL state (≠ null).
 */
export function createPortfolioRun(
  db: Sqlite,
  input: CreatePortfolioRunInput,
): CreatePortfolioRunResult {
  const workspaceId = input.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new Error('createPortfolioRun: workspaceId required');
  }

  const lanes = normalizeLanes(input.lanes);
  const now = Date.now();
  const portfolioRunId = `WS-${ulid(now)}`;
  const intent = typeof input.intent === 'string' ? input.intent : '';
  const parentName = intent
    ? `Portfolio: ${intent}`
    : 'Portfolio-Run';

  const laneWorkstreamIds: Record<string, string> = {};

  // NO intent column in the INSERT — it only arrived in migration 0051 and is
  // irrelevant for the portfolio substrate (the spine doesn't read it). This
  // keeps the writer independent of the intent migration state. The free
  // user intent (N1) lives in the parent name.
  const insertWs = db.prepare(
    `INSERT INTO workstreams
       (id, workspace_id, name, status, mode,
        parent_workstream_id, role,
        created_at, updated_at,
        cost_cents, tokens_in, tokens_out, cost_cents_aggregated)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  );

  // Atomic: parent + all lanes in one transaction.
  const tx = db.transaction(() => {
    // parent (mode='portfolio', parent IS NULL).
    insertWs.run(
      portfolioRunId,
      workspaceId,
      parentName,
      PORTFOLIO_MODE,
      null,
      null,
      now,
      now,
    );

    // child per lane (role='lane:<id>').
    for (let i = 0; i < lanes.length; i++) {
      const laneId = lanes[i];
      // +i on created_at, so the ORDER-BY-created_at-ASC read order
      // in the spine stably follows the lanes[] order.
      const childId = `WS-${ulid(now + 1 + i)}`;
      insertWs.run(
        childId,
        workspaceId,
        `Lane: ${laneId}`,
        null, // child mode stays NULL — only the parent is 'portfolio'.
        portfolioRunId,
        `lane:${laneId}`,
        now + 1 + i,
        now + 1 + i,
      );
      laneWorkstreamIds[laneId] = childId;
    }
  });
  tx();

  return { portfolioRunId, laneWorkstreamIds, lanes };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. advanceStage — Gate-gated Writer für Stage-Completions.
// ───────────────────────────────────────────────────────────────────────────

export interface AdvanceStageInput {
  portfolioRunId: string;
  stage: MergeStageId;
}

export type AdvanceStageResult =
  | {
      advanced: true;
      stage: MergeStageId;
      /** workstream_decisions.id of the written completion row. */
      decisionId: string;
      /** Which stages are merge-ready NOW (after the advance). */
      nextMergeable: MergeStageId[];
    }
  | {
      advanced: false;
      stage: MergeStageId;
      /** Verbatim rationale for why it was NOT advanced (N8-readable). */
      reason: string;
      /** The gate result (requires + gates), if the run existed. */
      gate: CanMergeStageResult | null;
    };

/**
 * Advances a stage — but ONLY when its gate is green (N6).
 *
 * Flow:
 *   1. Load the run via `loadPortfolioRunState`. No run → advanced:false.
 *   2. Check `canMergeStage(state, stage)` — LIVE validation of the gates +
 *      requires-DAG. Red → advanced:false, NO write.
 *   3. Green → write exactly ONE append-only decision row (N8/N9/N10).
 *      The stage thus counts as completed (the next read finds it).
 *   4. Return `nextMergeableStages` after the write (shows the advancement).
 *
 * NEVER advance a stage whose gate is red — that is the whole purpose
 * of the 11-sequence (gate red = hard stop, deterministic).
 *
 * Idempotency (N10): advancing the same stage twice writes NO second
 * row — either canMergeStage catches it (stage already in
 * completedMergeStages → ok=false), or the UNIQUE(content_hash) index applies.
 */
export function advanceStage(
  db: Sqlite,
  input: AdvanceStageInput,
): AdvanceStageResult {
  const { portfolioRunId, stage } = input;

  if (typeof portfolioRunId !== 'string' || portfolioRunId.length === 0) {
    return {
      advanced: false,
      stage,
      reason: 'advanceStage: portfolioRunId required',
      gate: null,
    };
  }

  // (1) Find the parent run to resolve the workspaceId, then load the state.
  const workspaceId = resolvePortfolioWorkspaceId(db, portfolioRunId);
  if (!workspaceId) {
    return {
      advanced: false,
      stage,
      reason: `advanceStage: no portfolio parent-workstream ${portfolioRunId}`,
      gate: null,
    };
  }

  const state = spine.loadPortfolioRunState(db, workspaceId);
  if (!state || state.portfolioRunId !== portfolioRunId) {
    // The most recent active run in the workspace is not this one — we
    // deliberately do NOT advance a different run (scope/race protection).
    return {
      advanced: false,
      stage,
      reason: `advanceStage: ${portfolioRunId} is not the active portfolio run for ${workspaceId}`,
      gate: null,
    };
  }

  // (2) Gate discipline — check LIVE (gates + requires-DAG).
  const gate = canMergeStage(state, stage);
  if (!gate.ok) {
    return {
      advanced: false,
      stage,
      reason: explainBlock(stage, state, gate),
      gate,
    };
  }

  // (3) Green → write exactly ONE completion decision (N8/N9/N10).
  const decisionId = writeStageCompletion(db, {
    portfolioRunId,
    workspaceId,
    stage,
  });
  if (!decisionId) {
    return {
      advanced: false,
      stage,
      reason: 'advanceStage: gate green but decision write failed',
      gate,
    };
  }

  // (4) Reload the state after the write → nextMergeableStages should advance.
  const after = spine.loadPortfolioRunState(db, workspaceId);
  const nextMergeable = after ? nextMergeableStages(after) : [];

  return { advanced: true, stage, decisionId, nextMergeable };
}

/**
 * Writes the stage-completion decision (append-only, idempotent via
 * UNIQUE(content_hash)). Returns the decision ID — or the existing
 * ID on a duplicate, or null on an error.
 *
 * We reuse the trace schema (migration 0071) directly on the raw handle,
 * instead of going through the `getDb()`-bound `writeDecision` — so the function
 * stays synchronous + in-memory testable (same pattern as loadPortfolioRunState).
 * Evidence-refs constraint (≥1): we write a sentinel evidence row into
 * workstream_evidence and reference it.
 */
function writeStageCompletion(
  db: Sqlite,
  args: { portfolioRunId: string; workspaceId: string; stage: MergeStageId },
): string | null {
  const rationale = stageCompletedRationale(args.stage);
  const ck = coordKey(args.workspaceId, args.portfolioRunId);

  try {
    return db.transaction(() => {
      // Sentinel evidence (evidence_refs needs ≥1 entry — 0071 CHECK).
      // N8 provenance: we write a real workstream_evidence row and
      // reference it. If the table is missing in a reduced schema,
      // we fall back fail-soft to a synthetic evidence ref — the
      // 0071 CHECK only requires a JSON array ≥1, NO FK on evidence.
      const evId = `ev_${ulid()}`;
      const evSourceRef = `spawn:${ck}`;
      const evHash = sha256hex({
        workstream_id: args.portfolioRunId,
        source_ref: evSourceRef,
        source_kind: 'spawn',
        snippet: rationale,
      });
      let evidenceId = evId;
      try {
        db.prepare(
          `INSERT OR IGNORE INTO workstream_evidence
             (id, workstream_id, source_ref, source_kind, content_hash, allowed, bridge_id, created_at)
           VALUES (?, ?, ?, 'spawn', ?, 1, NULL, unixepoch())`,
        ).run(evId, args.portfolioRunId, evSourceRef, evHash);
        const existingEv = db
          .prepare(
            `SELECT id FROM workstream_evidence
              WHERE workstream_id = ? AND source_ref = ? AND content_hash = ?
              LIMIT 1`,
          )
          .get(args.portfolioRunId, evSourceRef, evHash) as
          | { id: string }
          | undefined;
        evidenceId = existingEv?.id ?? evId;
      } catch (evErr) {
        // workstream_evidence missing (reduced schema) → synthetic ref.
        console.warn(
          '[portfolio/orchestrator] evidence write skipped (table missing?), using synthetic ref:',
          evErr instanceof Error ? evErr.message : String(evErr),
        );
        evidenceId = `synthetic:${evHash}`;
      }

      // Stage completion decision.
      const decId = `dec_${ulid()}`;
      const evidenceRefsJson = JSON.stringify([evidenceId]);
      // N10: content_hash over canonical JSON. Same stage on the same run
      // → same hash → idempotent (no duplicate advance write).
      const decHash = sha256hex({
        workstream_id: args.portfolioRunId,
        decision_kind: STAGE_DECISION_KIND,
        rationale,
        actor: STAGE_DECISION_ACTOR,
      });
      db.prepare(
        `INSERT OR IGNORE INTO workstream_decisions
           (id, workstream_id, decision_kind, rationale, evidence_refs,
            content_hash, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      ).run(
        decId,
        args.portfolioRunId,
        STAGE_DECISION_KIND,
        rationale,
        evidenceRefsJson,
        decHash,
        STAGE_DECISION_ACTOR,
      );

      const existingDec = db
        .prepare(
          `SELECT id FROM workstream_decisions
            WHERE workstream_id = ? AND content_hash = ?
            LIMIT 1`,
        )
        .get(args.portfolioRunId, decHash) as { id: string } | undefined;

      // Liveness bump on the parent (an advance is progress).
      db.prepare(`UPDATE workstreams SET updated_at = ? WHERE id = ?`).run(
        Date.now(),
        args.portfolioRunId,
      );

      return existingDec?.id ?? decId;
    })();
  } catch (err) {
    console.warn(
      '[portfolio/orchestrator] writeStageCompletion failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Verbatim rationale for a blocked advance (N8-readable). */
function explainBlock(
  stage: MergeStageId,
  state: PortfolioRunState,
  gate: CanMergeStageResult,
): string {
  if (state.completedMergeStages.includes(stage)) {
    return `stage '${stage}' already completed (idempotent no-op)`;
  }
  const parts: string[] = [];
  if (gate.blockingRequirements.length > 0) {
    parts.push(`requires: ${gate.blockingRequirements.join(', ')}`);
  }
  if (gate.blockingGates.length > 0) {
    parts.push(`gates-red: ${gate.blockingGates.join(', ')}`);
  }
  return `stage '${stage}' blocked — ${parts.join(' · ') || 'unknown'}`;
}

/**
 * Finds the workspaceId of a portfolio-parent workstream (mode='portfolio',
 * parent IS NULL). Returns null when the ID is not an active portfolio parent.
 * Fail-soft.
 */
function resolvePortfolioWorkspaceId(
  db: Sqlite,
  portfolioRunId: string,
): string | null {
  try {
    const row = db
      .prepare(
        `SELECT workspace_id FROM workstreams
          WHERE id = ?
            AND mode = '${PORTFOLIO_MODE}'
            AND parent_workstream_id IS NULL
          LIMIT 1`,
      )
      .get(portfolioRunId) as { workspace_id: string } | undefined;
    return row?.workspace_id ?? null;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 3. getPortfolioRunStatus — combined read (state + nextMergeable).
// ───────────────────────────────────────────────────────────────────────────

export interface PortfolioRunStatus {
  state: PortfolioRunState;
  nextMergeable: MergeStageId[];
}

/**
 * Loads the full run state of a portfolioRunId + computes which stages
 * are merge-ready NOW. Returns null when the run does not exist
 * or is not the active run of its workspace.
 */
export function getPortfolioRunStatus(
  db: Sqlite,
  portfolioRunId: string,
): PortfolioRunStatus | null {
  const workspaceId = resolvePortfolioWorkspaceId(db, portfolioRunId);
  if (!workspaceId) return null;
  const state = spine.loadPortfolioRunState(db, workspaceId);
  if (!state || state.portfolioRunId !== portfolioRunId) return null;
  return { state, nextMergeable: nextMergeableStages(state) };
}
