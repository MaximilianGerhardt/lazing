/**
 * Phase 2 W2.0 — Portfolio-Spine
 * ════════════════════════════════════════════════════════════════════════
 *
 * WAS DIESES MODUL IST
 * ────────────────────
 * Der **Portfolio-Spine** ist die deterministische Repräsentation der 11-
 * Stufen-Merge-Sequenz aus dem Master-Kontext §6 plus der 6 Quality-Gates
 * + des 12-Punkte-Lane-Vertrags aus dem Integration-Plan §6/§7.
 *
 * Er besteht aus drei Bausteinen:
 *
 *   1. `MERGE_SEQUENCE` — die 11 Stages als DAG (Dependency-Edges via
 *      `requires`). Reihenfolge ist load-bearing.
 *
 *   2. `QUALITY_GATES` — die 6 Gates G1..G6 als pure functions. Jeder Gate
 *      bekommt den vollen `PortfolioRunState` und liefert ein
 *      `QualityGateResult` mit `passed`, `reason`, `blockingItems`.
 *
 *   3. `LANE_CONTRACT_TEMPLATES` — pro Lane ein Template-Patch mit den
 *      bereits-bekannten Pflicht-Werten (z.B. governance hat
 *      confidenceBehavior='deterministic'). Der Restvertrag wird zur
 *      Laufzeit von der Lane selbst befüllt; `validateLaneContract` prüft
 *      auf Vollständigkeit.
 *
 * WAS DIESES MODUL NICHT IST
 * ──────────────────────────
 * Keine Execution-Engine. Es spawnt KEINE Workstreams, ruft KEINE LLMs,
 * macht KEINE Side-Effects. Reine Pure-Function-Library — alle Funktionen
 * sind deterministisch (N6) und nicht-werfend (fail-soft).
 *
 * OWNER-DIREKTIVE (verbatim, N1)
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
 * SUBSTRAT-DISZIPLIN (N4)
 * ───────────────────────
 * Keine neue Tabelle. Ein Portfolio-Run wird in `workstreams` repräsentiert:
 *
 *   parent-Workstream  — workstreams.mode = 'portfolio'
 *   pro-Lane-child-Workstream — parent_workstream_id = <parent>,
 *                               role = 'lane:<laneId>'
 *
 * Stage-Completions werden als `workstream_decisions(decision_kind='route',
 * rationale='portfolio-stage-completed: <stageId>')` Rows angehängt. Die
 * Tabelle ist append-only (Trigger aus 0071), was perfekt zur N8-/N10-
 * Disziplin passt.
 *
 * Die `loadPortfolioRunState`-Funktion liest diesen Zustand zurück —
 * read-only, fail-soft, ähnlich `projectWorkspaceState` aus
 * `lib/projection/state-projector.ts`.
 *
 * Stand: 2026-05-29
 */

import type { Database as Sqlite } from 'better-sqlite3';

// Contract-Persistenz-Slice (W3): liest den 12-Punkte-LaneContract pro
// Lane-Child aus der DB zurück. Runtime-only Import — `loadLaneContract` wird
// erst innerhalb von `loadPortfolioRunState` aufgerufen, nie auf Modul-Ebene
// (der entstehende contract-repo↔spine-Zyklus ist daher unkritisch).
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
// MERGE_SEQUENCE — die 11 Stages als DAG.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Die 11 Stages in kanonischer Order. Dependencies (requires) sind
 * konservativ — Stage N braucht typischerweise nur die DIREKT vorhergehende
 * Stage, plus eventuell den Governance-Gate-Contract (Stage 1), der über
 * allem hängt.
 *
 * Gates pro Stage: jede Stage MUSS mindestens G1 (Concept-Integrity) + G3
 * (Governance-Readiness) bestehen. Höhere Stages adden zusätzliche Gates
 * (G4 sobald der DAG sichtbar wird; G6 sobald wir auf den Build-Graph
 * zusteuern).
 *
 * Lanes pro Stage: jede Stage erbt die Lane(s), aus deren Output sie
 * konsolidiert. Stages 1, 9, 10, 11 sind „governance/critic/build/reconcile"-
 * lastig und ziehen die `governance`-Lane.
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
 * Lookup: Stage-ID → MergeStage. Für O(1)-Auflösung.
 */
const STAGE_BY_ID: Record<MergeStageId, MergeStage> = Object.fromEntries(
  MERGE_SEQUENCE.map((s) => [s.id, s]),
) as Record<MergeStageId, MergeStage>;

// ───────────────────────────────────────────────────────────────────────────
// QUALITY_GATES — die 6 Gates G1..G6.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hilfsfunktion: Sind alle Lanes, deren Output diese Stage braucht, in einem
 * akzeptablen Zustand?
 *
 * Wir prüfen für JEDE Lane des Run-States:
 *   - Lane hat einen LaneState-Eintrag (sollte immer der Fall sein, weil wir
 *     den Run-State immer mit allen 7 Lanes initialisieren).
 *   - Lane.contract ist gesetzt und valide.
 *
 * Die SET der zu prüfenden Lanes hängt vom Gate ab:
 *   - G1/G2/G3/G5 — alle 7 Lanes (jede muss ihr Versprechen einlösen).
 *   - G4 — alle Lanes, die in Stage 8 (flow-graph-workstream-dag) feeden:
 *     die 6 nicht-governance Lanes.
 *   - G6 — alle Lanes (Build-Readiness ist holistisch).
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
 * Hilfsfunktion: Hat MINDESTENS eine Lane einen `errorStates`-Eintrag?
 * Wenn keine einzige Lane Failure-Modes deklariert hat, ist das Concept
 * unvollständig (Integration-Plan §6: „keine Failure Modes benennt" verboten).
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

/** Type-Guard: ist der rohe Wert ein plausibles `PvArtifact`? */
function isPvArtifact(v: unknown): v is PvArtifact {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { objects?: unknown }).objects) &&
    Array.isArray((v as { expertDecisions?: unknown }).expertDecisions)
  );
}

/**
 * Wenn der Run-State einen Domain-Eval-Kontext mit einem ableitbaren
 * `PvArtifact` trägt, gibt diese Funktion das ECHTE G5-Verdikt zurück
 * (evaluateArtifact → toG5GateResult). Sonst `null` (G5 nutzt dann den
 * Lane-Contract-Fallback).
 *
 * Deterministisch (N6) + fail-soft: jeder Defekt im Kontext → `null`
 * (Fallback), niemals werfen.
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
    // Verbatim-Reason mit G5-Präfix anreichern, damit Owner/Critic sofort sehen,
    // dass G5 echt geprüft hat (nicht der Fallback).
    return {
      passed: result.passed,
      reason: `G5 (Domain-Eval): ${result.reason}`,
      blockingItems: result.blockingItems,
    };
  } catch {
    // fail-soft: Eval-Fehler → Fallback statt Crash.
    return null;
  }
}

export const QUALITY_GATES: readonly QualityGate[] = [
  {
    id: 'G1-concept-integrity',
    question:
      'Liefert die Lane echtes Konzept, nicht nur Screens oder Ideen?',
    validator: (state): QualityGateResult => {
      // Concept-Integrity = jede Lane hat (a) einen vollständigen Vertrag UND
      // (b) mindestens einen errorStates-Eintrag (Failure-Modes benannt).
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
      // Data-Readiness = jede Lane deklariert mindestens eine dataSchema-
      // Tabelle UND mindestens ein inputEvent ODER ein outputEvent.
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
      // Wir prüfen, dass die NICHT-Governance-Lanes jeweils inputEvents UND
      // outputEvents besitzen (eine Lane mit nur inputs oder nur outputs hängt
      // nicht im DAG).
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
      // ANTI-MVP-KERN (Master-Kontext §9): Wenn ein PV-Build-Artefakt im
      // Run-State hängt, prüft G5 ECHT gegen das kompilierte Fachmodell —
      // ein „nur Dachzeichner ohne Stringing/Speicher/Wechselrichter"-
      // Artefakt fällt hier deterministisch durch (missing-object/blocker).
      // Liegt KEIN PV-Artefakt vor (Nicht-PV-Lane), greift der bisherige
      // Lane-Contract-Heuristik-Fallback unten (Rückwärtskompatibilität).
      const evalResult = domainDepthFromEval(state);
      if (evalResult) return evalResult;

      // FALLBACK (Nicht-PV-Lane): Domain-Depth = mindestens eine Lane mit
      // confidenceBehavior != 'deterministic' MUSS humanReviewRequirements !=
      // 'none' setzen, ODER ihr Contract enthält explizite domain-spezifische
      // Metriken (metrics.length >= 2, weil ein „generischer Brei" oft nur 1
      // Metrik wie „done" liefert).
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
// LANE_CONTRACT_TEMPLATES — Pre-fill-Vorlagen pro Lane.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Templates spiegeln die Owner-Direktive aus Master-Briefing §25.1 (verbatim
 * gespeichert in `docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md`)
 * — jede Lane bekommt eine erwartete Confidence-Behavior + Audit-Zeile
 * vorab gesetzt, damit Implementer nicht von 0 starten. Listenfelder bleiben
 * leer; die Lane-Implementierung MUSS sie befüllen (sonst schlägt G1/G2/G3
 * fehl).
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
// validateLaneContract — 12-Punkte-Prüfung.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Prüft, ob ein Vertrag ALLE 12 Pflichtfelder vollständig liefert.
 *
 * „Vollständig" heißt:
 *   - Listen-Felder: length >= 1 (eine Lane ohne Failure-Modes wird abgelehnt;
 *     Integration-Plan §6).
 *   - Enum-Felder (confidenceBehavior, humanReviewRequirements): vorhanden
 *     und im Vokabular.
 *
 * Liefert verbatim Beschwerden („issues") für Owner / Critic-Loop.
 * Niemals werfen — fail-soft.
 */
export function validateLaneContract(
  contract: LaneContract | null | undefined,
): LaneContractValidation {
  const issues: string[] = [];

  if (!contract || typeof contract !== 'object') {
    return { valid: false, issues: ['contract is missing or not an object'] };
  }

  // Listen-Felder mit Mindest-1-Anforderung.
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
    // Jedes Element muss ein nicht-leerer String sein — wir wollen keinen
    // Eintrag „" (Owner würde es als „generische Featurelisten" werten).
    const bad = v.some((x) => typeof x !== 'string' || x.length === 0);
    if (bad) {
      issues.push(`${label}: contains non-string or empty entries`);
    }
  }

  // Enum-Felder.
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
 * Kann Stage `stageId` JETZT mergen?
 *
 * Bedingungen:
 *   1. Alle `requires`-Stages sind in `completedMergeStages`.
 *   2. Alle `gates` der Stage sind passed (wir rufen den Validator hier
 *      noch einmal LIVE auf — `passedQualityGates` im State ist nur ein
 *      Hint, kein Vertrauensbeweis).
 *
 * Niemals werfen.
 */
export function canMergeStage(
  state: PortfolioRunState,
  stageId: MergeStageId,
): CanMergeStageResult {
  const stage = STAGE_BY_ID[stageId];
  if (!stage) {
    return { ok: false, blockingRequirements: [], blockingGates: [] };
  }

  // (1) Stage darf nicht schon merged sein. „Schon merged" ist KEIN
  //     Blocker im klassischen Sinn, aber ok=false ist semantisch korrekt:
  //     du kannst nicht zweimal mergen.
  if (state.completedMergeStages.includes(stageId)) {
    return { ok: false, blockingRequirements: [], blockingGates: [] };
  }

  // (2) Dependency-Check.
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
      // fail-soft: Validator-Fehler = nicht-passed.
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
 * Welche Stages sind JETZT merge-ready?
 *
 * Liefert ALLE Stages, deren `canMergeStage` ok=true ist. In der Praxis
 * (sequenzieller Merge) wird das meistens 1 Stage sein — aber wir geben
 * eine Liste zurück, damit der Spine erweiterbar bleibt, falls der Owner
 * später parallele Stages (z.B. 5+6) erlaubt.
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
 * Führt einen einzelnen Quality-Gate-Check aus.
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
// PortfolioRunState-Konstruktion & DB-Persistenz
// ───────────────────────────────────────────────────────────────────────────

/**
 * Baut einen frischen `PortfolioRunState` — alle 7 Lanes als
 * `not-started` mit `contract: null`. Wird nach `createPortfolioRun`
 * (siehe unten) genutzt, oder direkt im Test für reine Spine-Logik-Probes.
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
 * Liest den aktuellen `PortfolioRunState` aus der DB.
 *
 * Substrat (N4):
 *   - parent-Workstream → workstreams.mode='portfolio', workspace_id=<ws>,
 *     jüngster aktiver Run gewinnt.
 *   - Pro Lane → child-Workstream mit role='lane:<laneId>'.
 *   - Stage-Completions → workstream_decisions(workstream_id=<parent>,
 *     decision_kind='route'), rationale beginnt mit 'portfolio-stage-completed: '.
 *
 * Wenn kein parent-Workstream existiert, liefert die Funktion NULL —
 * der Caller (API-Route) interpretiert das als „kein laufender
 * Portfolio-Run" und antwortet mit einem leeren Empty-State.
 *
 * Fail-soft: jedes SELECT in try/catch. Bei DB-Fehler → NULL.
 */
export function loadPortfolioRunState(
  raw: Sqlite,
  workspaceId: string,
): PortfolioRunState | null {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return null;

  // (1) parent-Workstream.
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

  // (2) child-Lanes.
  const state = emptyPortfolioRunState({
    portfolioRunId: parent.id,
    workspaceId,
    startedAt: parent.created_at,
  });

  // Alle Workstream-IDs dieses Runs (parent + children). Der pv-stringing-
  // Producer (BAHN-2) schreibt seine Decision in den Workstream des LAUFENDEN
  // Steps — das ist im Portfolio-Pfad ein child-Lane-Workstream (z.B.
  // expertise-compiler), in einem flachen Run der parent selbst. Wir sammeln
  // beide Ebenen, damit der G5-Hop (Schritt 3.5) sie alle abdeckt.
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
      // W3 Contract-Persistenz: den 12-Punkte-Vertrag dieser Lane aus der DB
      // zurücklesen (statt undefined/in-memory-injiziert). So entscheiden die
      // 6 Gates (G1..G6) in Produktion über ECHTE Lane-Verträge. Fail-soft:
      // kein persistierter Vertrag → bleibt null (rückwärtskompatibel — die
      // Gates behandeln „kein Vertrag" exakt wie vor diesem Slice).
      const persisted = loadLaneContract(raw, row.id);
      if (persisted) ls.contract = persisted;
    }
  } catch {
    /* fail-soft */
  }

  // (3) Stage-Completions aus workstream_decisions.
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
    /* fail-soft — wenn die Tabelle fehlt, ist completedMergeStages eben leer. */
  }

  // (3.5) DER LIVE-G5-HOP (2026-05-30): pv-stringing-Producer-Output → domainEval.
  //
  // Der deterministische pv-stringing-Producer (lib/workstreams/plan-executor.ts
  // ::runPvStringingStep) legt sein PvArtifact persistent als
  // workstream_decisions(decision_kind='route', actor='policy') ab, deren
  // rationale mit `pv_stringing_producer=true` beginnt und den maschinen-
  // lesbaren `<pv-stringing-artifact>{…}</…>`-Block enthält. Bisher hat NIEMAND
  // dieses Substrat in state.domainEval überführt → G5 lief im echten Flow nie
  // scharf (nur im Unit-/Wiring-Test). Hier schließen wir den Hop:
  //
  //   workstream_decisions.rationale  →  buildPvDomainEvalFromDecisions
  //     →  mapArtifactToPvArtifact  →  state.domainEval  (G5 LIVE in Schritt 4).
  //
  // Fail-soft (N6): kein pv-stringing-Output in irgendeiner Decision → domainEval
  // bleibt null → G5 nutzt den Lane-Contract-Fallback (exakt das alte, korrekte
  // Verhalten; ein „nur Dachzeichner"-Run BLOCKt wie gehabt). Niemals werfen.
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
    /* fail-soft — kein domainEval → G5-Fallback. */
  }

  // (4) blockedAt-Heuristik: erste nicht-merged Stage, deren canMergeStage
  //     ok=false ist (entweder requires fehlen oder Gates fehlen), gilt als
  //     blockierend. Wir setzen blockedReason mit verbatim Gate/requires-Info.
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
    // Wir brechen NICHT ab — wir wollen die erste blockierte Stage. Wenn die
    // erste merge-ready ist, ist blockedAt am Ende immer noch null.
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

// Re-export der Typen aus dem types-Modul für bequemen Konsum.
export * from './types';
