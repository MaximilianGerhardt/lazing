/**
 * Phase 2 W2.0 — Portfolio-Spine · Types
 * ════════════════════════════════════════════════════════════════════════
 *
 * Diese Datei deklariert das Vokabular der **11-Stufen-Merge-Sequenz** und
 * des **Lane-Vertrags**, die der Owner als unverhandelbare Klammer
 * über jeden Portfolio-Run gesetzt hat. Verbatim-Quellen (N1):
 *
 *   • Master-Kontext §6 — Sequenzieller Merge: 1. Governance Gate Contract,
 *     2. Source / Event Envelope, 3. Expertise Object Model,
 *     4. Role / Decision / Dependency Model, 5. Toolstack Replacement Model,
 *     6. Innovation Reframe Model, 7. Mobile Surface Model,
 *     8. Flow Graph / Workstream DAG, 9. Critic / Eval Gates,
 *     10. Build Graph, 11. Reconciliation / Belief Update.
 *
 *   • Integration-Plan §6 — Jede Lane muss zwingend liefern: Input-Events ·
 *     Output-Events · Data-Schema · Permission-Requirements ·
 *     Confidence-Behavior · Human-Review-Requirements · Error-States ·
 *     Audit/Provenance · UX-Surfaces · Metrics · Test-Fixtures ·
 *     Rollout-Constraints. „Eine Lane ist nicht akzeptiert, wenn sie
 *     nur Ideen liefert, Screens zeigt, generische Featurelisten
 *     produziert, harte Fachlogik auf später verschiebt, keine Source
 *     Trace besitzt, keine Failure Modes benennt."
 *
 *   • Integration-Plan §7 — 6 Quality-Gates G1..G6.
 *
 * Datei ist rein deklarativ — keine Implementierung, keine Runtime-Imports
 * auf der Modul-Ebene. Spine-Logik lebt in `spine.ts`.
 *
 * SUBSTRAT-DISZIPLIN (N4: keine neue Tabelle):
 *   Ein Portfolio-Run = 1 parent-Workstream (`workstreams.mode='portfolio'`).
 *   Pro Lane = 1 child-Workstream (`parent_workstream_id=<parent>`).
 *   Lane-Artefakte = `workstream_decisions` + `workspace_beliefs`.
 *   Stage-Completion = `workstream_decisions(decision_kind='route')` mit
 *     rationale-Text, der den Stage-Übergang dokumentiert. (decision_kind ist
 *     CHECK-constrained in 0071; wir reusen den 'route'-Kind und tragen die
 *     Stage-ID in rationale.)
 *
 * Stand: 2026-05-29
 */

// ───────────────────────────────────────────────────────────────────────────
// Lane vocabulary
// ───────────────────────────────────────────────────────────────────────────

/**
 * Die 7 Lanes der Portfolio-Pipeline (verbatim aus Integration-Plan §4).
 *
 *   • communication-intake     — übersetzt User-Input → Source-Event-Envelopes
 *                                + Dependency-Hinweise. Nährstoff für Lanes 2–4.
 *   • expertise-compiler       — baut domain-spezifische Expertise-Objekte
 *                                aus Intake-Envelopes. Liefert Domain-Depth.
 *   • role-reverse-engineering — leitet Rollen/Entscheidungen/Dependencies aus
 *                                Real-World-Workflows ab.
 *   • innovation-mode          — reframt Probleme; liefert das Innovation-
 *                                Reframe-Model (Stage 6).
 *   • toolstack-replacement    — bewertet existierende Tools und liefert das
 *                                Toolstack-Replacement-Model (Stage 5).
 *   • mobile-ux                — liefert das Mobile Surface Model (Stage 7).
 *   • governance               — liefert das Governance-Gate-Contract (Stage 1)
 *                                + die Quality-Gate-Validatoren.
 */
export type LaneId =
  | 'communication-intake'
  | 'expertise-compiler'
  | 'role-reverse-engineering'
  | 'innovation-mode'
  | 'toolstack-replacement'
  | 'mobile-ux'
  | 'governance';

/**
 * Vollständige Liste aller Lanes als Konstante.
 * Wird vom Spine + von Tests + UI-Konsumenten als Source-of-Truth genutzt.
 */
export const LANE_IDS: readonly LaneId[] = [
  'communication-intake',
  'expertise-compiler',
  'role-reverse-engineering',
  'innovation-mode',
  'toolstack-replacement',
  'mobile-ux',
  'governance',
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Lane Contract
// ───────────────────────────────────────────────────────────────────────────

/**
 * Confidence-Behavior einer Lane (Integration-Plan §6).
 *
 *   • deterministic            — SQL/Rule-only, kein LLM, kein Human-Review.
 *   • llm-with-validation      — LLM-Output wird mit deterministischem
 *                                Validator geprüft (N6 Vorrang).
 *   • llm-with-human-review    — Output braucht explizites human-decision-Gate.
 */
export type ConfidenceBehavior =
  | 'deterministic'
  | 'llm-with-validation'
  | 'llm-with-human-review';

/**
 * Human-Review-Anforderung (Integration-Plan §6).
 */
export type HumanReviewRequirement = 'none' | 'optional' | 'required';

/**
 * Lane-Vertrag — die 12 Pflichtfelder aus Integration-Plan §6.
 *
 * Ein Vertrag ist „komplett" und „akzeptiert", wenn:
 *   1. ALLE 12 Felder vorhanden sind (kein Feld undefined).
 *   2. Listen-Felder mindestens 1 Eintrag haben (keine leeren Arrays).
 *      Ausnahme: errorStates darf leer sein — eine Lane ohne Failure-Modes
 *      ist EXPLIZIT verboten (Integration-Plan §6: „keine Failure Modes
 *      benennt" → Lane wird abgelehnt), darum verlangen wir auch hier ≥1.
 *
 * Die Felder spiegeln den Integration-Plan §6 1:1 — die Reihenfolge ist
 * absichtlich identisch zur Owner-Direktive für leichten Diff.
 */
export interface LaneContract {
  /** Event-Typen, die diese Lane KONSUMIERT (Input). */
  inputEvents: string[];
  /** Event-Typen, die diese Lane EMITTIERT (Output). */
  outputEvents: string[];
  /** Tabellen/Views, aus denen sie liest oder in die sie schreibt. */
  dataSchema: string[];
  /** Permissions, die sie braucht (z.B. 'workspace:read', 'governance:write'). */
  permissionRequirements: string[];
  /** Wie sie zu ihrer Aussage kommt (deterministic / llm-mit-validator / human-review). */
  confidenceBehavior: ConfidenceBehavior;
  /** Ob ein human-decision-Gate vor Stage-Completion zwingend ist. */
  humanReviewRequirements: HumanReviewRequirement;
  /** Benannte Fehler-Zustände (Integration-Plan §6: „keine Failure Modes benennt" ist verboten). */
  errorStates: string[];
  /** Audit-/Provenance-Anforderungen (z.B. 'workstream_evidence-row pro retrieval'). */
  auditRequirements: string[];
  /** Surface-Kinds, die sie im Chat zeigt (z.B. 'open-questions', 'plan-step'). */
  uxSurfaces: string[];
  /** Benannte Metriken (z.B. 'intake_envelope_count', 'expertise_depth_score'). */
  metrics: string[];
  /** Test-Fixture-Pfade/Namen. */
  testFixtures: string[];
  /** Rollout-Constraints (z.B. 'dry-run only until owner LIVE-flip'). */
  rolloutConstraints: string[];
}

/**
 * Ergebnis der Vertragsprüfung. Wird vom Spine + von der API zurückgegeben.
 */
export interface LaneContractValidation {
  valid: boolean;
  /**
   * Verbatim-Beschwerden, die für den Owner / Critic-Loop lesbar sind.
   * Mehrere Issues möglich (alle 12 Felder werden geprüft, nicht nur das erste).
   */
  issues: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Merge Stages
// ───────────────────────────────────────────────────────────────────────────

/**
 * Die 11 Stages der sequenziellen Merge-Sequenz (Master-Kontext §6).
 * Reihenfolge ist load-bearing — Stage N darf nur mergen, wenn alle
 * Dependencies abgeschlossen sind (siehe MergeStage.requires).
 */
export type MergeStageId =
  | 'governance-gate-contract'
  | 'source-event-envelope'
  | 'expertise-object-model'
  | 'role-decision-dependency-model'
  | 'toolstack-replacement-model'
  | 'innovation-reframe-model'
  | 'mobile-surface-model'
  | 'flow-graph-workstream-dag'
  | 'critic-eval-gates'
  | 'build-graph'
  | 'reconciliation-belief-update';

/**
 * Stage-Order ist 1..11 (Master-Kontext §6). Die Reihenfolge wird sowohl
 * als Type-Constraint als auch als Konstante exportiert.
 */
export type MergeStageOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface MergeStage {
  id: MergeStageId;
  order: MergeStageOrder;
  /** Welche Stages MÜSSEN merged sein, bevor diese mergen darf. */
  requires: MergeStageId[];
  /** Welche Lanes feeden in diese Stage (Output-Artefakte werden hier konsolidiert). */
  lanes: LaneId[];
  /** Welche Quality-Gates müssen passen, BEVOR diese Stage mergen darf. */
  gates: QualityGateId[];
}

// ───────────────────────────────────────────────────────────────────────────
// Quality Gates
// ───────────────────────────────────────────────────────────────────────────

/**
 * Die 6 Quality-Gates aus Integration-Plan §7 (verbatim).
 *
 *   • G1 Concept-Integrity     — Liefert die Lane echtes Konzept (kein Slide)?
 *   • G2 Data-Readiness        — Sind Schema/Events vorhanden?
 *   • G3 Governance-Readiness  — Gibt es Permissions/Audit?
 *   • G4 Workflow-Readiness    — Hängt die Lane in den DAG?
 *   • G5 Domain-Depth          — Hat sie echte Fachlogik (kein generischer
 *                                Feature-Brei)?
 *   • G6 Build-Readiness       — Ist sie testbar/build-fähig?
 */
export type QualityGateId =
  | 'G1-concept-integrity'
  | 'G2-data-readiness'
  | 'G3-governance-readiness'
  | 'G4-workflow-readiness'
  | 'G5-domain-depth'
  | 'G6-build-readiness';

export interface QualityGate {
  id: QualityGateId;
  /** Verbatim-Frage aus Integration-Plan §7. */
  question: string;
  /** Pure function — nimmt den Run-State, gibt ein Ergebnis. Deterministisch (N6). */
  validator: (state: PortfolioRunState) => QualityGateResult;
}

export interface QualityGateResult {
  passed: boolean;
  /** Verbatim-Begründung — wird in workstream_decisions.rationale gespiegelt. */
  reason: string;
  /** Konkrete Items, die noch fehlen (z.B. Lane-IDs ohne Contract). */
  blockingItems: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Domain-Eval-Kontext (G5 Anti-MVP-Brücke)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Optional domain-eval context attached to the run state when a Demo PV
 * (photovoltaic) build artifact is present. When set, G5 (domain depth)
 * checks for REAL against the compiled domain model instead of only against
 * the lane-contract heuristic (list-length proxy).
 *
 * `pvArtifact` is deliberately typed `unknown`: `types.ts` is purely
 * declarative and must NOT pull a runtime/type import on the eval module
 * (layering discipline — the spine imports the eval module, not the reverse).
 * The spine casts `pvArtifact` at eval time to the strict `PvArtifact`
 * structure. The adapter `mapArtifactToPvArtifact` (lib/eval/demo-pv/
 * from-artifact.ts) returns exactly that structure fail-soft.
 */
export interface DomainEvalContext {
  /** A `PvArtifact` (lib/eval/demo-pv/domain-model.ts). */
  pvArtifact: unknown;
  /** Which test case is armed (e.g. 'simple-roof'). */
  testCaseId: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Portfolio Run State
// ───────────────────────────────────────────────────────────────────────────

export type LaneRunStatus =
  | 'not-started'
  | 'running'
  | 'awaiting-merge'
  | 'merged'
  | 'failed';

export interface LaneState {
  laneId: LaneId;
  /** workstreams.id des child-Workstream, der diese Lane physisch repräsentiert (NULL bis spawn). */
  workstreamId: string | null;
  status: LaneRunStatus;
  /** Aktueller Vertrags-Stand. NULL = noch nicht geschrieben. */
  contract: LaneContract | null;
  /** Referenzen auf produzierte Artefakte (workstream_decisions.id / workspace_beliefs.id / …). */
  artifactRefs: string[];
}

export interface PortfolioRunState {
  /** workstreams.id des parent-Workstream (mode='portfolio'). */
  portfolioRunId: string;
  workspaceId: string;
  /** ms epoch. */
  startedAt: number;
  /** Pro Lane EIN Eintrag. Vollständig — auch nicht-gestartete Lanes werden geführt. */
  laneStates: Record<LaneId, LaneState>;
  /** Stages, die bereits merged sind. Strikt aufsteigend (1..11). */
  completedMergeStages: MergeStageId[];
  /** Gates, die für mindestens einen Merge bestanden wurden (informational; nicht persistent). */
  passedQualityGates: QualityGateId[];
  /** Falls aktuell ein Merge blockiert ist, hier die Stage + Verbatim-Grund. */
  blockedAt: MergeStageId | null;
  blockedReason: string | null;
  /**
   * Optionaler Domain-Eval-Kontext. Wenn gesetzt, prüft G5 (Domain-Depth)
   * ECHT gegen das kompilierte PV-Fachmodell statt nur gegen die Lane-
   * Contract-Heuristik. NULL/undefined = Nicht-PV-Lane → G5-Fallback.
   */
  domainEval?: DomainEvalContext | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers für Validatoren + canMergeStage
// ───────────────────────────────────────────────────────────────────────────

export interface CanMergeStageResult {
  ok: boolean;
  /** Stages, die noch fehlen (Dependency-Verletzung). */
  blockingRequirements: MergeStageId[];
  /** Quality-Gates, die nicht passed sind. */
  blockingGates: QualityGateId[];
}
