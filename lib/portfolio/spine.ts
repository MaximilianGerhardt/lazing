/**
 * Phase 2 W2.0 — portfolio spine
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS MODULE IS
 * ────────────────────
 * The **portfolio spine** is the deterministic representation of the 11-
 * stage merge sequence from master context §6 plus the 6 quality gates
 * + the 12-point lane contract from the integration plan §6/§7.
 *
 * It consists of three building blocks:
 *
 *   1. `MERGE_SEQUENCE` — the 11 stages as a DAG (dependency edges via
 *      `requires`). The order is load-bearing.
 *
 *   2. `QUALITY_GATES` — the 6 gates G1..G6 as pure functions. Each gate
 *      gets the full `PortfolioRunState` and returns a
 *      `QualityGateResult` with `passed`, `reason`, `blockingItems`.
 *
 *   3. `LANE_CONTRACT_TEMPLATES` — one template patch per lane with the
 *      already-known mandatory values (e.g. governance has
 *      confidenceBehavior='deterministic'). The rest of the contract is filled
 *      at runtime by the lane itself; `validateLaneContract` checks
 *      for completeness.
 *
 * WHAT THIS MODULE IS NOT
 * ──────────────────────────
 * Not an execution engine. It spawns NO workstreams, calls NO LLMs,
 * makes NO side effects. A pure function library — all functions
 * are deterministic (N6) and non-throwing (fail-soft).
 *
 * OWNER DIRECTIVE (verbatim, N1)
 * ──────────────────────────────
 *
 *   Master-Kontext §6:
 *     „Sequenzieller Merge: 1. Governance Gate Contract · 2. Source /
 *      Event Envelope · 3. Expertise Object Model · 4. Role / Decision /
 *      Dependency Model · 5. Toolstack Replacement Model · 6. Innovation
 *      Reframe Model · 7. Mobile Surface Model · 8. Flow Graph /
 *      Workstream DAG · 9. Critic / Eval Gates · 10. Build Graph ·
 *      11. Reconciliation / Belief Update."
 *
 *   Integration-Plan §6:
 *     „Eine Lane ist nicht akzeptiert, wenn sie nur Ideen liefert,
 *      Screens zeigt, generische Featurelisten produziert, harte
 *      Fachlogik auf später verschiebt, keine Source Trace besitzt,
 *      keine Failure Modes benennt."
 *
 *   Integration-Plan §7 (verbatim Gate-Fragen, übernommen in QUALITY_GATES.question):
 *     G1 Concept-Integrity      — „Liefert die Lane echtes Konzept, nicht
 *                                  nur Screens oder Ideen?"
 *     G2 Data-Readiness         — „Sind die nötigen Schemas/Events
 *                                  vorhanden und konsumierbar?"
 *     G3 Governance-Readiness   — „Gibt es Permissions, Audit-Trails
 *                                  und Provenance pro Output?"
 *     G4 Workflow-Readiness     — „Hängt die Lane im DAG (Input/Output
 *                                  verkabelt mit Vorgängern/Nachfolgern)?"
 *     G5 Domain-Depth           — „Hat sie echte Fachlogik (kein
 *                                  generischer Feature-Brei)?"
 *     G6 Build-Readiness        — „Ist sie test- und build-fähig
 *                                  (Fixtures + Rollout-Constraints)?"
 *
 * SUBSTRATE DISCIPLINE (N4)
 * ───────────────────────
 * No new table. A portfolio run is represented in `workstreams`:
 *
 *   parent workstream  — workstreams.mode = 'portfolio'
 *   per-lane child workstream — parent_workstream_id = <parent>,
 *                               role = 'lane:<laneId>'
 *
 * Stage completions are appended as `workstream_decisions(decision_kind='route',
 * rationale='portfolio-stage-completed: <stageId>')` rows. The
 * table is append-only (trigger from 0071), which fits the N8/N10
 * discipline perfectly.
 *
 * The `loadPortfolioRunState` function reads this state back —
 * read-only, fail-soft, similar to `projectWorkspaceState` from
 * `lib/projection/state-projector.ts`.
 *
 * As of: 2026-05-29
 */

import type { Database as Sqlite } from 'better-sqlite3';

// Contract persistence slice (W3): reads the 12-point LaneContract per
// lane-child back from the DB. Runtime-only import — `loadLaneContract` is
// only called inside `loadPortfolioRunState`, never at module level
// (so the resulting contract-repo↔spine cycle is harmless).
import { loadLaneContract } from './contract-repo';

import type { PvArtifact } from '@/lib/eval/demo-pv/domain-model';
import { evaluateArtifact, toG5GateResult } from '@/lib/eval/demo-pv/evaluate';
import {
  PV_STRINGING_DECISION_PREFIX,
  buildPvDomainEvalFromDecisions,
} from '@/lib/eval/demo-pv/from-decisions';
import {
  PV_EVAL_TEST_CASE_IDS,
  getTestCase,
  type TestCaseId,
} from '@/lib/eval/demo-pv/test-cases';

import type {
  CanMergeStageResult,
  LaneContract,
  LaneContractValidation,
  LaneId,
  LaneState,
  MergeStage,
  MergeStageId,
  PortfolioRunState,
  QualityGate,
  QualityGateId,
  QualityGateResult,
} from './types';
import { LANE_IDS } from './types';

// ───────────────────────────────────────────────────────────────────────────
// MERGE_SEQUENCE — the 11 stages as a DAG.
// ───────────────────────────────────────────────────────────────────────────

/**
 * The 11 stages in canonical order. Dependencies (requires) are
 * conservative — stage N typically needs only the DIRECTLY preceding
 * stage, plus possibly the governance-gate contract (stage 1), which hangs
 * over everything.
 *
 * Gates per stage: every stage MUST pass at least G1 (concept integrity) + G3
 * (governance readiness). Higher stages add additional gates
 * (G4 as soon as the DAG becomes visible; G6 as soon as we head toward the
 * build graph).
 *
 * Lanes per stage: every stage inherits the lane(s) whose output it
 * consolidates. Stages 1, 9, 10, 11 are „governance/critic/build/reconcile"-
 * heavy and pull in the `governance` lane.
 */
export const MERGE_SEQUENCE: readonly MergeStage[] = [
  {
    id: 'governance-gate-contract',
    order: 1,
    requires: [],
    lanes: ['governance'],
    gates: ['G1-concept-integrity', 'G3-governance-readiness'],
  },
  {
    id: 'source-event-envelope',
    order: 2,
    requires: ['governance-gate-contract'],
    lanes: ['communication-intake'],
    gates: ['G1-concept-integrity', 'G2-data-readiness'],
  },
  {
    id: 'expertise-object-model',
    order: 3,
    requires: ['source-event-envelope'],
    lanes: ['expertise-compiler'],
    gates: ['G1-concept-integrity', 'G2-data-readiness', 'G5-domain-depth'],
  },
  {
    id: 'role-decision-dependency-model',
    order: 4,
    requires: ['expertise-object-model'],
    lanes: ['role-reverse-engineering'],
    gates: ['G1-concept-integrity', 'G5-domain-depth'],
  },
  {
    id: 'toolstack-replacement-model',
    order: 5,
    requires: ['role-decision-dependency-model'],
    lanes: ['toolstack-replacement'],
    gates: ['G1-concept-integrity', 'G5-domain-depth'],
  },
  {
    id: 'innovation-reframe-model',
    order: 6,
    requires: ['toolstack-replacement-model'],
    lanes: ['innovation-mode'],
    gates: ['G1-concept-integrity'],
  },
  {
    id: 'mobile-surface-model',
    order: 7,
    requires: ['innovation-reframe-model'],
    lanes: ['mobile-ux'],
    gates: ['G1-concept-integrity'],
  },
  {
    id: 'flow-graph-workstream-dag',
    order: 8,
    requires: ['mobile-surface-model'],
    lanes: [
      'communication-intake',
      'expertise-compiler',
      'role-reverse-engineering',
      'innovation-mode',
      'toolstack-replacement',
      'mobile-ux',
    ],
    gates: ['G1-concept-integrity', 'G4-workflow-readiness'],
  },
  {
    id: 'critic-eval-gates',
    order: 9,
    requires: ['flow-graph-workstream-dag'],
    lanes: ['governance'],
    gates: ['G1-concept-integrity', 'G3-governance-readiness'],
  },
  {
    id: 'build-graph',
    order: 10,
    requires: ['critic-eval-gates'],
    lanes: ['governance'],
    gates: [
      'G1-concept-integrity',
      'G3-governance-readiness',
      'G6-build-readiness',
    ],
  },
  {
    id: 'reconciliation-belief-update',
    order: 11,
    requires: ['build-graph'],
    lanes: ['governance'],
    gates: [
      'G1-concept-integrity',
      'G3-governance-readiness',
      'G6-build-readiness',
    ],
  },
] as const;

/**
 * Lookup: stage ID → MergeStage. For O(1) resolution.
 */
const STAGE_BY_ID: Record<MergeStageId, MergeStage> = Object.fromEntries(
  MERGE_SEQUENCE.map((s) => [s.id, s]),
) as Record<MergeStageId, MergeStage>;

// ───────────────────────────────────────────────────────────────────────────
// QUALITY_GATES — the 6 gates G1..G6.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Helper: are all lanes whose output this stage needs in an
 * acceptable state?
 *
 * For EVERY lane of the run state we check:
 *   - the lane has a LaneState entry (should always be the case, because we
 *     always initialize the run state with all 7 lanes).
 *   - lane.contract is set and valid.
 *
 * The SET of lanes to check depends on the gate:
 *   - G1/G2/G3/G5 — all 7 lanes (each must deliver on its promise).
 *   - G4 — all lanes that feed into stage 8 (flow-graph-workstream-dag):
 *     the 6 non-governance lanes.
 *   - G6 — all lanes (build readiness is holistic).
 */
function lanesWithMissingContract(state: PortfolioRunState, lanes: LaneId[]): LaneId[] {
  const missing: LaneId[] = [];
  for (const id of lanes) {
    const ls = state.laneStates[id];
    if (!ls || !ls.contract) {
      missing.push(id);
      continue;
    }
    const v = validateLaneContract(ls.contract);
    if (!v.valid) missing.push(id);
  }
  return missing;
}

/**
 * Helper: does AT LEAST one lane have an `errorStates` entry?
 * If not a single lane has declared failure modes, the concept is
 * incomplete (integration plan §6: „keine Failure Modes benennt" forbidden).
 */
function someLaneHasErrorStates(state: PortfolioRunState): boolean {
  for (const id of LANE_IDS) {
    const c = state.laneStates[id]?.contract;
    if (c && c.errorStates.length > 0) return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// G5 anti-MVP bridge: real Demo PV domain eval (instead of a list-length proxy)
// ───────────────────────────────────────────────────────────────────────────

/** Type guard: is the raw value a plausible `PvArtifact`? */
function isPvArtifact(v: unknown): v is PvArtifact {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { objects?: unknown }).objects) &&
    Array.isArray((v as { expertDecisions?: unknown }).expertDecisions)
  );
}

/**
 * When the run state carries a domain-eval context with a derivable
 * `PvArtifact`, this function returns the REAL G5 verdict
 * (evaluateArtifact → toG5GateResult). Otherwise `null` (G5 then uses the
 * lane-contract fallback).
 *
 * Deterministic (N6) + fail-soft: any defect in the context → `null`
 * (fallback), never throws.
 */
function domainDepthFromEval(state: PortfolioRunState): QualityGateResult | null {
  const ctx = state.domainEval;
  if (!ctx || typeof ctx !== 'object') return null;
  if (!isPvArtifact(ctx.pvArtifact)) return null;
  if (typeof ctx.testCaseId !== 'string') return null;
  if (!PV_EVAL_TEST_CASE_IDS.includes(ctx.testCaseId as TestCaseId)) return null;

  try {
    const testCase = getTestCase(ctx.testCaseId as TestCaseId);
    const verdict = evaluateArtifact(ctx.pvArtifact, testCase);
    const result = toG5GateResult(verdict);
    // Enrich the verbatim reason with a G5 prefix so owner/critic immediately see
    // that G5 actually checked (not the fallback).
    return {
      passed: result.passed,
      reason: `G5 (Domain-Eval): ${result.reason}`,
      blockingItems: result.blockingItems,
    };
  } catch {
    // fail-soft: eval error → fallback instead of crash.
    return null;
  }
}

export const QUALITY_GATES: readonly QualityGate[] = [
  {
    id: 'G1-concept-integrity',
    question:
      'Liefert die Lane echtes Konzept, nicht nur Screens oder Ideen?',
    validator: (state): QualityGateResult => {
      // Concept integrity = every lane has (a) a complete contract AND
      // (b) at least one errorStates entry (failure modes named).
      const missing = lanesWithMissingContract(state, [...LANE_IDS]);
      if (missing.length > 0) {
        return {
          passed: false,
          reason:
            'G1: Lane-Verträge unvollständig — Lane(s) ohne vollständigen 12-Punkte-Vertrag.',
          blockingItems: missing,
        };
      }
      if (!someLaneHasErrorStates(state)) {
        return {
          passed: false,
          reason:
            'G1: keine einzige Lane hat Failure-Modes benannt (Integration-Plan §6: verboten).',
          blockingItems: [],
        };
      }
      return { passed: true, reason: 'G1 ok', blockingItems: [] };
    },
  },
  {
    id: 'G2-data-readiness',
    question:
      'Sind die nötigen Schemas/Events vorhanden und konsumierbar?',
    validator: (state): QualityGateResult => {
      // Data readiness = every lane declares at least one dataSchema
      // table AND at least one inputEvent OR one outputEvent.
      const blockingItems: string[] = [];
      for (const id of LANE_IDS) {
        const c = state.laneStates[id]?.contract;
        if (!c) {
          blockingItems.push(id);
          continue;
        }
        if (c.dataSchema.length === 0) {
          blockingItems.push(`${id}:no-data-schema`);
        }
        if (c.inputEvents.length === 0 && c.outputEvents.length === 0) {
          blockingItems.push(`${id}:no-events`);
        }
      }
      if (blockingItems.length > 0) {
        return {
          passed: false,
          reason:
            'G2: Daten-Substrat fehlt — Lane(s) ohne dataSchema oder ohne Events.',
          blockingItems,
        };
      }
      return { passed: true, reason: 'G2 ok', blockingItems: [] };
    },
  },
  {
    id: 'G3-governance-readiness',
    question:
      'Gibt es Permissions, Audit-Trails und Provenance pro Output?',
    validator: (state): QualityGateResult => {
      const blockingItems: string[] = [];
      for (const id of LANE_IDS) {
        const c = state.laneStates[id]?.contract;
        if (!c) {
          blockingItems.push(id);
          continue;
        }
        if (c.permissionRequirements.length === 0) {
          blockingItems.push(`${id}:no-permissions`);
        }
        if (c.auditRequirements.length === 0) {
          blockingItems.push(`${id}:no-audit`);
        }
      }
      if (blockingItems.length > 0) {
        return {
          passed: false,
          reason:
            'G3: Governance-Substrat fehlt — Lane(s) ohne permissionRequirements oder auditRequirements.',
          blockingItems,
        };
      }
      return { passed: true, reason: 'G3 ok', blockingItems: [] };
    },
  },
  {
    id: 'G4-workflow-readiness',
    question:
      'Hängt die Lane im DAG (Input/Output verkabelt mit Vorgängern/Nachfolgern)?',
    validator: (state): QualityGateResult => {
      // We check that the NON-governance lanes each have inputEvents AND
      // outputEvents (a lane with only inputs or only outputs does not hang
      // in the DAG).
      const blockingItems: string[] = [];
      const nonGovLanes: LaneId[] = LANE_IDS.filter((l) => l !== 'governance');
      for (const id of nonGovLanes) {
        const c = state.laneStates[id]?.contract;
        if (!c) {
          blockingItems.push(id);
          continue;
        }
        if (c.inputEvents.length === 0 || c.outputEvents.length === 0) {
          blockingItems.push(`${id}:incomplete-io`);
        }
      }
      if (blockingItems.length > 0) {
        return {
          passed: false,
          reason:
            'G4: DAG unvollständig — Lane(s) mit fehlenden Input- oder Output-Events.',
          blockingItems,
        };
      }
      return { passed: true, reason: 'G4 ok', blockingItems: [] };
    },
  },
  {
    id: 'G5-domain-depth',
    question:
      'Hat sie echte Fachlogik (kein generischer Feature-Brei)?',
    validator: (state): QualityGateResult => {
      // ANTI-MVP CORE (master context §9): when a PV build artifact hangs in the
      // run state, G5 checks REALLY against the compiled domain model —
      // a „nur Dachzeichner ohne Stringing/Speicher/Wechselrichter"
      // artifact fails here deterministically (missing-object/blocker).
      // If NO PV artifact is present (non-PV lane), the previous
      // lane-contract heuristic fallback below applies (backwards compatibility).
      const evalResult = domainDepthFromEval(state);
      if (evalResult) return evalResult;

      // FALLBACK (non-PV lane): domain depth = at least one lane with
      // confidenceBehavior != 'deterministic' MUST set humanReviewRequirements !=
      // 'none', OR its contract contains explicit domain-specific
      // metrics (metrics.length >= 2, because a „generischer Brei" often delivers only 1
      // metric like „done").
      const shallow: string[] = [];
      for (const id of LANE_IDS) {
        const c = state.laneStates[id]?.contract;
        if (!c) {
          shallow.push(id);
          continue;
        }
        const isLLM = c.confidenceBehavior !== 'deterministic';
        const hasReview = c.humanReviewRequirements !== 'none';
        const hasMultipleMetrics = c.metrics.length >= 2;
        if (isLLM && !hasReview && !hasMultipleMetrics) {
          shallow.push(`${id}:shallow-domain`);
        }
      }
      if (shallow.length > 0) {
        return {
          passed: false,
          reason:
            'G5: Domain-Depth fehlt — LLM-Lane(s) ohne Human-Review und ohne mehrere Metriken (generischer Feature-Brei verboten).',
          blockingItems: shallow,
        };
      }
      return { passed: true, reason: 'G5 ok', blockingItems: [] };
    },
  },
  {
    id: 'G6-build-readiness',
    question:
      'Ist sie test- und build-fähig (Fixtures + Rollout-Constraints)?',
    validator: (state): QualityGateResult => {
      const blockingItems: string[] = [];
      for (const id of LANE_IDS) {
        const c = state.laneStates[id]?.contract;
        if (!c) {
          blockingItems.push(id);
          continue;
        }
        if (c.testFixtures.length === 0) {
          blockingItems.push(`${id}:no-fixtures`);
        }
        if (c.rolloutConstraints.length === 0) {
          blockingItems.push(`${id}:no-rollout-constraints`);
        }
      }
      if (blockingItems.length > 0) {
        return {
          passed: false,
          reason:
            'G6: Build/Test-Substrat fehlt — Lane(s) ohne testFixtures oder rolloutConstraints.',
          blockingItems,
        };
      }
      return { passed: true, reason: 'G6 ok', blockingItems: [] };
    },
  },
] as const;

const GATE_BY_ID: Record<QualityGateId, QualityGate> = Object.fromEntries(
  QUALITY_GATES.map((g) => [g.id, g]),
) as Record<QualityGateId, QualityGate>;

// ───────────────────────────────────────────────────────────────────────────
// LANE_CONTRACT_TEMPLATES — pre-fill templates per lane.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Templates mirror the owner directive from master briefing §25.1 (stored
 * verbatim in `docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md`)
 * — every lane gets an expected confidence behavior + audit line
 * pre-set, so implementers don't start from 0. List fields stay
 * empty; the lane implementation MUST fill them (otherwise G1/G2/G3
 * fails).
 */
export const LANE_CONTRACT_TEMPLATES: Readonly<Record<LaneId, Partial<LaneContract>>> = {
  'communication-intake': {
    confidenceBehavior: 'llm-with-validation',
    humanReviewRequirements: 'optional',
    auditRequirements: [
      'workstream_evidence: source=user pro intake-envelope',
    ],
    uxSurfaces: ['open-questions', 'plan-step'],
  },
  'expertise-compiler': {
    confidenceBehavior: 'llm-with-validation',
    humanReviewRequirements: 'optional',
    auditRequirements: [
      'workstream_decisions: kind=route mit evidence_refs auf Source-Envelopes',
    ],
    uxSurfaces: ['plan-step'],
  },
  'role-reverse-engineering': {
    confidenceBehavior: 'llm-with-validation',
    humanReviewRequirements: 'optional',
    auditRequirements: [
      'workstream_decisions: kind=route mit evidence_refs auf Expertise-Objects',
    ],
    uxSurfaces: ['plan-step'],
  },
  'innovation-mode': {
    confidenceBehavior: 'llm-with-human-review',
    humanReviewRequirements: 'required',
    auditRequirements: [
      'workstream_decisions: kind=override für jeden Reframe',
      'workspace_beliefs: Reframe-Belief mit Soft-FK auf decision',
    ],
    uxSurfaces: ['human-decision', 'plan-step'],
  },
  'toolstack-replacement': {
    confidenceBehavior: 'llm-with-validation',
    humanReviewRequirements: 'optional',
    auditRequirements: [
      'workstream_decisions: kind=route pro Tool-Vergleich',
    ],
    uxSurfaces: ['plan-step'],
  },
  'mobile-ux': {
    confidenceBehavior: 'llm-with-human-review',
    humanReviewRequirements: 'required',
    auditRequirements: [
      'workstream_decisions: kind=route für Mobile-Surface-Entscheidung',
    ],
    uxSurfaces: ['human-decision'],
  },
  governance: {
    confidenceBehavior: 'deterministic',
    humanReviewRequirements: 'required',
    auditRequirements: [
      'workstream_decisions: kind=bridge für cross-scope-Approvals',
      'workstream_evidence: pro Gate-Check eine Row',
    ],
    uxSurfaces: ['human-decision', 'live-warn'],
  },
};

// ───────────────────────────────────────────────────────────────────────────
// validateLaneContract — 12-point check.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Checks whether a contract delivers ALL 12 mandatory fields completely.
 *
 * „Complete" means:
 *   - list fields: length >= 1 (a lane without failure modes is rejected;
 *     integration plan §6).
 *   - enum fields (confidenceBehavior, humanReviewRequirements): present
 *     and in the vocabulary.
 *
 * Returns verbatim complaints („issues") for the owner / critic loop.
 * Never throws — fail-soft.
 */
export function validateLaneContract(
  contract: LaneContract | null | undefined,
): LaneContractValidation {
  const issues: string[] = [];

  if (!contract || typeof contract !== 'object') {
    return { valid: false, issues: ['contract is missing or not an object'] };
  }

  // List fields with a minimum-1 requirement.
  const listFields: Array<[keyof LaneContract, string]> = [
    ['inputEvents', 'inputEvents'],
    ['outputEvents', 'outputEvents'],
    ['dataSchema', 'dataSchema'],
    ['permissionRequirements', 'permissionRequirements'],
    ['errorStates', 'errorStates (Integration-Plan §6: Failure Modes pflicht)'],
    ['auditRequirements', 'auditRequirements'],
    ['uxSurfaces', 'uxSurfaces'],
    ['metrics', 'metrics'],
    ['testFixtures', 'testFixtures'],
    ['rolloutConstraints', 'rolloutConstraints'],
  ];

  for (const [key, label] of listFields) {
    const v = (contract as unknown as Record<string, unknown>)[key as string];
    if (!Array.isArray(v)) {
      issues.push(`${label}: not an array`);
      continue;
    }
    if (v.length === 0) {
      issues.push(`${label}: empty (min 1 required)`);
      continue;
    }
    // Every element must be a non-empty string — we don't want an
    // entry „" (the owner would count it as „generische Featurelisten").
    const bad = v.some((x) => typeof x !== 'string' || x.length === 0);
    if (bad) {
      issues.push(`${label}: contains non-string or empty entries`);
    }
  }

  // Enum fields.
  const confidence = contract.confidenceBehavior;
  if (
    confidence !== 'deterministic' &&
    confidence !== 'llm-with-validation' &&
    confidence !== 'llm-with-human-review'
  ) {
    issues.push(
      `confidenceBehavior: missing or invalid (got ${JSON.stringify(confidence)})`,
    );
  }

  const human = contract.humanReviewRequirements;
  if (human !== 'none' && human !== 'optional' && human !== 'required') {
    issues.push(
      `humanReviewRequirements: missing or invalid (got ${JSON.stringify(human)})`,
    );
  }

  return { valid: issues.length === 0, issues };
}

// ───────────────────────────────────────────────────────────────────────────
// canMergeStage / nextMergeableStages / runQualityGate
// ───────────────────────────────────────────────────────────────────────────

/**
 * Can stage `stageId` merge NOW?
 *
 * Conditions:
 *   1. All `requires` stages are in `completedMergeStages`.
 *   2. All `gates` of the stage are passed (we call the validator here
 *      once more LIVE — `passedQualityGates` in the state is only a
 *      hint, not proof of trust).
 *
 * Never throws.
 */
export function canMergeStage(
  state: PortfolioRunState,
  stageId: MergeStageId,
): CanMergeStageResult {
  const stage = STAGE_BY_ID[stageId];
  if (!stage) {
    return { ok: false, blockingRequirements: [], blockingGates: [] };
  }

  // (1) The stage must not already be merged. „Already merged" is NOT a
  //     blocker in the classic sense, but ok=false is semantically correct:
  //     you cannot merge twice.
  if (state.completedMergeStages.includes(stageId)) {
    return { ok: false, blockingRequirements: [], blockingGates: [] };
  }

  // (2) Dependency check.
  const completedSet = new Set(state.completedMergeStages);
  const blockingRequirements = stage.requires.filter(
    (r) => !completedSet.has(r),
  );

  // (3) Gates.
  const blockingGates: QualityGateId[] = [];
  for (const gateId of stage.gates) {
    const gate = GATE_BY_ID[gateId];
    if (!gate) continue;
    let result: QualityGateResult;
    try {
      result = gate.validator(state);
    } catch {
      // fail-soft: validator error = not passed.
      result = { passed: false, reason: 'validator threw', blockingItems: [] };
    }
    if (!result.passed) blockingGates.push(gateId);
  }

  return {
    ok: blockingRequirements.length === 0 && blockingGates.length === 0,
    blockingRequirements,
    blockingGates,
  };
}

/**
 * Which stages are merge-ready NOW?
 *
 * Returns ALL stages whose `canMergeStage` is ok=true. In practice
 * (sequential merge) this will usually be 1 stage — but we return
 * a list so the spine stays extensible in case the owner
 * later allows parallel stages (e.g. 5+6).
 */
export function nextMergeableStages(state: PortfolioRunState): MergeStageId[] {
  const out: MergeStageId[] = [];
  for (const stage of MERGE_SEQUENCE) {
    const r = canMergeStage(state, stage.id);
    if (r.ok) out.push(stage.id);
  }
  return out;
}

/**
 * Runs a single quality-gate check.
 */
export function runQualityGate(
  state: PortfolioRunState,
  gateId: QualityGateId,
): QualityGateResult {
  const gate = GATE_BY_ID[gateId];
  if (!gate) {
    return {
      passed: false,
      reason: `unknown gate: ${gateId}`,
      blockingItems: [],
    };
  }
  try {
    return gate.validator(state);
  } catch (err) {
    return {
      passed: false,
      reason: `validator threw: ${(err as Error)?.message ?? 'unknown'}`,
      blockingItems: [],
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PortfolioRunState construction & DB persistence
// ───────────────────────────────────────────────────────────────────────────

/**
 * Builds a fresh `PortfolioRunState` — all 7 lanes as
 * `not-started` with `contract: null`. Used after `createPortfolioRun`
 * (see below), or directly in tests for pure spine-logic probes.
 */
export function emptyPortfolioRunState(args: {
  portfolioRunId: string;
  workspaceId: string;
  startedAt: number;
}): PortfolioRunState {
  const laneStates = {} as Record<LaneId, LaneState>;
  for (const id of LANE_IDS) {
    laneStates[id] = {
      laneId: id,
      workstreamId: null,
      status: 'not-started',
      contract: null,
      artifactRefs: [],
    };
  }
  return {
    portfolioRunId: args.portfolioRunId,
    workspaceId: args.workspaceId,
    startedAt: args.startedAt,
    laneStates,
    completedMergeStages: [],
    passedQualityGates: [],
    blockedAt: null,
    blockedReason: null,
    domainEval: null,
  };
}

/**
 * Reads the current `PortfolioRunState` from the DB.
 *
 * Substrate (N4):
 *   - parent workstream → workstreams.mode='portfolio', workspace_id=<ws>,
 *     the most recent active run wins.
 *   - per lane → child workstream with role='lane:<laneId>'.
 *   - stage completions → workstream_decisions(workstream_id=<parent>,
 *     decision_kind='route'), rationale begins with 'portfolio-stage-completed: '.
 *
 * When no parent workstream exists, the function returns NULL —
 * the caller (API route) interprets that as „no running
 * portfolio run" and responds with an empty state.
 *
 * Fail-soft: every SELECT in try/catch. On a DB error → NULL.
 */
export function loadPortfolioRunState(
  raw: Sqlite,
  workspaceId: string,
): PortfolioRunState | null {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null;

  // (1) parent workstream.
  let parent:
    | {
        id: string;
        created_at: number;
      }
    | undefined;
  try {
    parent = raw
      .prepare(
        `SELECT id, created_at FROM workstreams
          WHERE workspace_id = ?
            AND mode = 'portfolio'
            AND parent_workstream_id IS NULL
            AND status IN ('active','paused')
          ORDER BY updated_at DESC
          LIMIT 1`,
      )
      .get(workspaceId) as { id: string; created_at: number } | undefined;
  } catch {
    parent = undefined;
  }
  if (!parent) return null;

  // (2) child lanes.
  const state = emptyPortfolioRunState({
    portfolioRunId: parent.id,
    workspaceId,
    startedAt: parent.created_at,
  });

  // All workstream IDs of this run (parent + children). The pv-stringing
  // producer (BAHN-2) writes its decision into the workstream of the RUNNING
  // step — that is, in the portfolio path a child-lane workstream (e.g.
  // expertise-compiler), in a flat run the parent itself. We collect
  // both levels so the G5 hop (step 3.5) covers them all.
  const runWorkstreamIds: string[] = [parent.id];

  try {
    const children = raw
      .prepare(
        `SELECT id, role, status FROM workstreams
          WHERE parent_workstream_id = ?
          ORDER BY created_at ASC`,
      )
      .all(parent.id) as Array<{
      id: string;
      role: string | null;
      status: string;
    }>;
    for (const row of children) {
      if (row.id) runWorkstreamIds.push(row.id);
      if (!row.role || !row.role.startsWith('lane:')) continue;
      const laneId = row.role.slice('lane:'.length) as LaneId;
      if (!LANE_IDS.includes(laneId)) continue;
      const ls = state.laneStates[laneId];
      ls.workstreamId = row.id;
      ls.status = mapWorkstreamStatusToLane(row.status);
      // W3 contract persistence: read this lane's 12-point contract from the DB
      // (instead of undefined/in-memory-injected). So the
      // 6 gates (G1..G6) decide over REAL lane contracts in production. Fail-soft:
      // no persisted contract → stays null (backwards-compatible — the
      // gates treat „no contract" exactly as before this slice).
      const persisted = loadLaneContract(raw, row.id);
      if (persisted) ls.contract = persisted;
    }
  } catch {
    /* fail-soft */
  }

  // (3) Stage completions from workstream_decisions.
  try {
    const rows = raw
      .prepare(
        `SELECT rationale FROM workstream_decisions
          WHERE workstream_id = ?
            AND decision_kind = 'route'
          ORDER BY created_at ASC`,
      )
      .all(parent.id) as Array<{ rationale: string }>;
    for (const r of rows) {
      const prefix = 'portfolio-stage-completed: ';
      if (typeof r.rationale === 'string' && r.rationale.startsWith(prefix)) {
        const id = r.rationale.slice(prefix.length) as MergeStageId;
        if (STAGE_BY_ID[id] && !state.completedMergeStages.includes(id)) {
          state.completedMergeStages.push(id);
        }
      }
    }
  } catch {
    /* fail-soft — if the table is missing, completedMergeStages is simply empty. */
  }

  // (3.5) THE LIVE G5 HOP (2026-05-30): pv-stringing producer output → domainEval.
  //
  // The deterministic pv-stringing producer (lib/workstreams/plan-executor.ts
  // ::runPvStringingStep) persists its PvArtifact as
  // workstream_decisions(decision_kind='route', actor='policy'), whose
  // rationale begins with `pv_stringing_producer=true` and contains the machine-
  // readable `<pv-stringing-artifact>{…}</…>` block. Until now NOBODY
  // transferred this substrate into state.domainEval → G5 never ran sharp in the real flow
  // (only in the unit/wiring test). Here we close the hop:
  //
  //   workstream_decisions.rationale  →  buildPvDomainEvalFromDecisions
  //     →  mapArtifactToPvArtifact  →  state.domainEval  (G5 LIVE in step 4).
  //
  // Fail-soft (N6): no pv-stringing output in any decision → domainEval
  // stays null → G5 uses the lane-contract fallback (exactly the old, correct
  // behavior; a „nur Dachzeichner" run BLOCKS as before). Never throws.
  try {
    const placeholders = runWorkstreamIds.map(() => '?').join(', ');
    const decisionRows = raw
      .prepare(
        `SELECT rationale FROM workstream_decisions
          WHERE workstream_id IN (${placeholders})
            AND decision_kind = 'route'
            AND rationale LIKE ?
          ORDER BY created_at ASC`,
      )
      .all(...runWorkstreamIds, `${PV_STRINGING_DECISION_PREFIX}%`) as Array<{
      rationale: string;
    }>;
    const rationales = decisionRows.map((r) => r.rationale);
    const domainEval = buildPvDomainEvalFromDecisions(rationales);
    if (domainEval) {
      state.domainEval = domainEval;
    }
  } catch {
    /* fail-soft — no domainEval → G5 fallback. */
  }

  // (4) blockedAt heuristic: the first non-merged stage whose canMergeStage
  //     is ok=false (either requires are missing or gates are missing) counts as
  //     blocking. We set blockedReason with verbatim gate/requires info.
  for (const stage of MERGE_SEQUENCE) {
    if (state.completedMergeStages.includes(stage.id)) continue;
    const r = canMergeStage(state, stage.id);
    if (!r.ok) {
      state.blockedAt = stage.id;
      const reasons: string[] = [];
      if (r.blockingRequirements.length > 0) {
        reasons.push(`requires: ${r.blockingRequirements.join(', ')}`);
      }
      if (r.blockingGates.length > 0) {
        reasons.push(`gates: ${r.blockingGates.join(', ')}`);
      }
      state.blockedReason = reasons.join(' · ') || 'unknown';
    }
    // We do NOT break — we want the first blocked stage. If the
    // first one is merge-ready, blockedAt is still null at the end.
    if (state.blockedAt !== null) break;
  }

  return state;
}

/**
 * Map workstreams.status → LaneRunStatus.
 */
function mapWorkstreamStatusToLane(
  status: string,
): import('./types').LaneRunStatus {
  switch (status) {
    case 'active':
      return 'running';
    case 'paused':
      return 'awaiting-merge';
    case 'done':
      return 'merged';
    case 'failed':
    case 'stuck':
      return 'failed';
    default:
      return 'not-started';
  }
}

// Re-export of the types from the types module for convenient consumption.
export * from './types';
