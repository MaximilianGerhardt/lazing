/**
 * Phase 2 W2.x — Portfolio-Orchestrator (der WRITER zur Lese-Brille `spine.ts`)
 * ════════════════════════════════════════════════════════════════════════
 *
 * WAS DIESES MODUL IST
 * ────────────────────
 * `spine.ts` ist eine **Lese-Brille ohne Writer**: `loadPortfolioRunState`
 * erwartet einen parent-Workstream (`mode='portfolio'`), pro Lane einen
 * child-Workstream (`role='lane:<id>'`) und Stage-Completions als
 * `workstream_decisions(decision_kind='route', rationale='portfolio-stage-
 * completed: <stage>')`. Bis hierher schrieb NIEMAND diese Rows — also lieferte
 * `loadPortfolioRunState` immer `null`.
 *
 * Dieses Modul ist der fehlende WRITER. Es erzeugt einen ECHTEN Portfolio-Run
 * und advanced Stages — aber NUR, wenn das Gate der Stage grün ist (N6
 * deterministisch). Nach `createPortfolioRun` sieht der Spine den Run
 * (`loadPortfolioRunState !== null`).
 *
 * SUBSTRAT-DISZIPLIN (N4)
 * ───────────────────────
 * KEINE neue Tabelle, KEINE swarm_runs/swarm_branches. Ein Portfolio-Run wird
 * vollständig in `workstreams` + `workstream_decisions` repräsentiert — exakt
 * die Rows, die der Spine zurückliest:
 *
 *   parent-Workstream            → workstreams.mode='portfolio', parent IS NULL
 *   pro-Lane-child-Workstream    → parent_workstream_id=<parent>,
 *                                  role='lane:<laneId>'
 *   Stage-Completion             → workstream_decisions(decision_kind='route',
 *                                  rationale='portfolio-stage-completed: <id>',
 *                                  actor='policy')
 *
 * GATE-DISZIPLIN (der ganze Zweck der 11-Sequenz)
 * ───────────────────────────────────────────────
 * `advanceStage` ruft `canMergeStage(loadPortfolioRunState(...), stage)`.
 *   - rote Gates ODER fehlende requires → KEIN Advance, KEIN Decision-Write.
 *   - Stage N kann NIE vor Stage N-1 advancen (requires-DAG, deterministisch).
 *   - grün → genau EINE append-only Decision-Row → Stage gilt als completed.
 *
 * Constraints-Mapping:
 *   N6  — Gate-Validatoren sind pure/deterministisch; rotes Gate blockt hart.
 *   N8  — jede Stage-Completion schreibt eine „warum?"-Decision-Row (Trace).
 *   N9  — jede Decision trägt einen ManifestCoord-Key (workspace/run).
 *   N10 — content_hash (sha256 über kanonisches JSON) pro Decision-Row;
 *         Duplikat-Hash = idempotent (UNIQUE-Index, ON CONFLICT IGNORE).
 *
 * Schnittstellen-Form: wie `loadPortfolioRunState` arbeitet dieses Modul direkt
 * auf dem rohen `better-sqlite3`-Handle (`db.$raw`). Das hält es synchron,
 * deterministisch und in-memory-testbar (gleiches Muster wie `spine.test.ts`).
 *
 * Stand: 2026-05-29
 */

import { createHash } from 'node:crypto';

import type { Database as Sqlite } from 'better-sqlite3';

import { ulid } from '@/lib/ulid';

// Namespace-Import des Spine, damit der Reader (`loadPortfolioRunState`) eine
// EINZIGE, überschreibbare Bindung ist — der Advance-Pfad MUSS denselben Reader
// nutzen, den auch die GET-Route + Tests sehen (Single-Source-of-Truth für den
// Run-State; ermöglicht außerdem Test-Doubles ohne Produktions-Sonderpfad).
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
// Konstanten — exakt das Vokabular, das loadPortfolioRunState zurückliest.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Der EXAKTE Rationale-Präfix, auf den `loadPortfolioRunState` matched
 * (`spine.ts`: `const prefix = 'portfolio-stage-completed: '`). Inklusive
 * Trailing-Space. Wird verbatim verwendet — NICHT ändern, ohne den Reader
 * gleichzeitig anzupassen, sonst sieht der Spine die Completion nicht.
 */
export const STAGE_COMPLETED_PREFIX = 'portfolio-stage-completed: ';

/** workstreams.mode-Marker für den parent-Run. */
const PORTFOLIO_MODE = 'portfolio';

/** Decision-Kind, den der Spine für Stage-Completions liest (CHECK 0071). */
const STAGE_DECISION_KIND = 'route';

/** Actor der Stage-Advance-Decision — der Spine wertet ihn nicht aus, aber N8/N5
 *  verlangen, dass eine deterministische Policy-Advance als 'policy' markiert
 *  ist (kein 'agent'/'user'-Maskieren einer Maschinen-Entscheidung). */
const STAGE_DECISION_ACTOR = 'policy';

// ───────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ───────────────────────────────────────────────────────────────────────────

/** SHA-256 über ein kanonisches JSON-Objekt (N10). Immer 64 hex-Zeichen. */
function sha256hex(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** Kanonischer ManifestCoord-Key (N9): "<workspaceId>/<runId>". */
function coordKey(workspaceId: string, runId: string): string {
  return `${workspaceId}/${runId}`;
}

/** Rationale-Text für eine Stage-Completion — exakt im Reader-Format. */
function stageCompletedRationale(stage: MergeStageId): string {
  return `${STAGE_COMPLETED_PREFIX}${stage}`;
}

/**
 * Normalisiert die übergebene Lane-Liste auf gültige, eindeutige LaneIds.
 * Leere/ungültige Liste → alle 7 kanonischen Lanes (Default-Vollbild).
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
  // Falls die Liste nur Müll enthielt → Default-Vollbild statt leerem Run.
  return out.length > 0 ? out : [...LANE_IDS];
}

// ───────────────────────────────────────────────────────────────────────────
// 1. createPortfolioRun — der Writer, der den Run materialisiert.
// ───────────────────────────────────────────────────────────────────────────

export interface CreatePortfolioRunInput {
  workspaceId: string;
  /**
   * Welche Lanes der Run führt. Leer/undefined → alle 7 kanonischen Lanes.
   * Ungültige Lane-IDs werden gefiltert (deterministisch, N6).
   */
  lanes?: readonly string[];
  /** Verbatim User-Intent (N1) — landet im parent-Namen + Description. */
  intent?: string;
}

export interface CreatePortfolioRunResult {
  /** workstreams.id des parent-Workstream (mode='portfolio'). */
  portfolioRunId: string;
  /** Pro Lane → child-Workstream-ID. */
  laneWorkstreamIds: Record<string, string>;
  /** Die normalisierten Lanes, die tatsächlich angelegt wurden. */
  lanes: LaneId[];
}

/**
 * Erzeugt einen Portfolio-Run als 1 parent + N child Workstreams (N4).
 *
 *   parent → mode='portfolio', parent_workstream_id IS NULL, status='active'
 *   child  → parent_workstream_id=parent, role='lane:<laneId>', status='active'
 *
 * Alle Inserts laufen in EINER Transaktion (atomar — entweder der ganze Run
 * existiert oder keiner). Deterministisch, synchron, in-memory-testbar.
 *
 * Gibt die portfolioRunId + die child-Workstream-IDs zurück. Nach diesem Call
 * liefert `loadPortfolioRunState(db, workspaceId)` einen ECHTEN State (≠ null).
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

  // KEINE intent-Spalte im INSERT — sie kam erst in Migration 0051 und ist
  // für das Portfolio-Substrat irrelevant (der Spine liest sie nicht). So
  // bleibt der Writer unabhängig vom Intent-Migrationsstand. Der freie
  // User-Intent (N1) lebt im parent-Namen.
  const insertWs = db.prepare(
    `INSERT INTO workstreams
       (id, workspace_id, name, status, mode,
        parent_workstream_id, role,
        created_at, updated_at,
        cost_cents, tokens_in, tokens_out, cost_cents_aggregated)
     VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  );

  // Atomar: parent + alle Lanes in einer Transaktion.
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

    // child pro Lane (role='lane:<id>').
    for (let i = 0; i < lanes.length; i++) {
      const laneId = lanes[i];
      // +i auf created_at, damit die ORDER-BY-created_at-ASC-Lese-Reihenfolge
      // im Spine stabil der lanes[]-Reihenfolge folgt.
      const childId = `WS-${ulid(now + 1 + i)}`;
      insertWs.run(
        childId,
        workspaceId,
        `Lane: ${laneId}`,
        null, // child-Mode bleibt NULL — nur der parent ist 'portfolio'.
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
      /** workstream_decisions.id der geschriebenen Completion-Row. */
      decisionId: string;
      /** Welche Stages JETZT (nach dem Advance) merge-ready sind. */
      nextMergeable: MergeStageId[];
    }
  | {
      advanced: false;
      stage: MergeStageId;
      /** Verbatim-Begründung, warum NICHT advanced wurde (N8-lesbar). */
      reason: string;
      /** Das Gate-Resultat (requires + Gates), falls der Run existierte. */
      gate: CanMergeStageResult | null;
    };

/**
 * Advanced eine Stage — aber NUR, wenn ihr Gate grün ist (N6).
 *
 * Ablauf:
 *   1. Run laden via `loadPortfolioRunState`. Kein Run → advanced:false.
 *   2. `canMergeStage(state, stage)` prüfen — LIVE-Validierung der Gates +
 *      requires-DAG. Rot → advanced:false, KEIN Write.
 *   3. Grün → genau EINE append-only Decision-Row schreiben (N8/N9/N10).
 *      Die Stage gilt damit als completed (der nächste Read findet sie).
 *   4. `nextMergeableStages` nach dem Write zurückgeben (zeigt das Vorrücken).
 *
 * NIEMALS eine Stage advancen, deren Gate rot ist — das ist der ganze Zweck
 * der 11-Sequenz (Gate-rot = harter Stopp, deterministisch).
 *
 * Idempotenz (N10): zweimal dieselbe Stage advancen schreibt KEINEN zweiten
 * Row — entweder fängt canMergeStage das ab (Stage schon in
 * completedMergeStages → ok=false), oder der UNIQUE(content_hash)-Index greift.
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

  // (1) Den parent-Run finden, um workspaceId aufzulösen, dann State laden.
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
    // Der jüngste aktive Run im Workspace ist nicht dieser — wir advancen
    // bewusst NICHT einen anderen Run (Scope-/Race-Schutz).
    return {
      advanced: false,
      stage,
      reason: `advanceStage: ${portfolioRunId} is not the active portfolio run for ${workspaceId}`,
      gate: null,
    };
  }

  // (2) Gate-Disziplin — LIVE prüfen (Gates + requires-DAG).
  const gate = canMergeStage(state, stage);
  if (!gate.ok) {
    return {
      advanced: false,
      stage,
      reason: explainBlock(stage, state, gate),
      gate,
    };
  }

  // (3) Grün → genau EINE Completion-Decision schreiben (N8/N9/N10).
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

  // (4) State nach dem Write neu laden → nextMergeableStages soll vorrücken.
  const after = spine.loadPortfolioRunState(db, workspaceId);
  const nextMergeable = after ? nextMergeableStages(after) : [];

  return { advanced: true, stage, decisionId, nextMergeable };
}

/**
 * Schreibt die Stage-Completion-Decision (append-only, idempotent via
 * UNIQUE(content_hash)). Gibt die Decision-ID zurück — oder die existierende
 * ID bei Duplikat, oder null bei Fehler.
 *
 * Wir reusen das Trace-Schema (Migration 0071) direkt auf dem rohen Handle,
 * statt durch `getDb()`-gebundene `writeDecision` zu gehen — damit die Funktion
 * synchron + in-memory-testbar bleibt (gleiches Muster wie loadPortfolioRunState).
 * Evidence-Refs-Constraint (≥1): wir schreiben einen Sentinel-Evidence-Row in
 * workstream_evidence und referenzieren ihn.
 */
function writeStageCompletion(
  db: Sqlite,
  args: { portfolioRunId: string; workspaceId: string; stage: MergeStageId },
): string | null {
  const rationale = stageCompletedRationale(args.stage);
  const ck = coordKey(args.workspaceId, args.portfolioRunId);

  try {
    return db.transaction(() => {
      // Sentinel-Evidence (evidence_refs braucht ≥1 Eintrag — 0071 CHECK).
      // N8-Provenance: wir schreiben eine echte workstream_evidence-Row und
      // referenzieren sie. Falls die Tabelle in einem reduzierten Schema fehlt,
      // fallen wir fail-soft auf einen synthetischen Evidence-Ref zurück — der
      // 0071-CHECK verlangt nur ein JSON-Array ≥1, KEINEN FK auf evidence.
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
        // workstream_evidence fehlt (reduziertes Schema) → synthetischer Ref.
        console.warn(
          '[portfolio/orchestrator] evidence write skipped (table missing?), using synthetic ref:',
          evErr instanceof Error ? evErr.message : String(evErr),
        );
        evidenceId = `synthetic:${evHash}`;
      }

      // Stage-Completion-Decision.
      const decId = `dec_${ulid()}`;
      const evidenceRefsJson = JSON.stringify([evidenceId]);
      // N10: content_hash über kanonisches JSON. Gleiche Stage am gleichen Run
      // → gleicher Hash → idempotent (kein doppelter Advance-Write).
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

      // Liveness-Bump auf parent (advance ist Fortschritt).
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

/** Verbatim-Begründung für einen geblockten Advance (N8-lesbar). */
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
 * Findet die workspaceId eines portfolio-parent-Workstream (mode='portfolio',
 * parent IS NULL). Gibt null zurück, wenn die ID kein aktiver Portfolio-Parent
 * ist. Fail-soft.
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
// 3. getPortfolioRunStatus — kombinierter Read (State + nextMergeable).
// ───────────────────────────────────────────────────────────────────────────

export interface PortfolioRunStatus {
  state: PortfolioRunState;
  nextMergeable: MergeStageId[];
}

/**
 * Lädt den vollen Run-State eines portfolioRunId + berechnet, welche Stages
 * JETZT merge-ready sind. Gibt null zurück, wenn der Run nicht existiert
 * oder nicht der aktive Run seines Workspace ist.
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
