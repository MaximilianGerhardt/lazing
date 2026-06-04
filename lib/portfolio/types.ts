/**
 * Phase 2 W2.0 — portfolio spine · types
 * ════════════════════════════════════════════════════════════════════════
 *
 * This file declares the vocabulary of the **11-stage merge sequence** and
 * the **lane contract** that the owner set as a non-negotiable bracket
 * over every portfolio run. Verbatim sources (N1):
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
 *   • Integration-Plan §7 — 6 quality gates G1..G6.
 *
 * The file is purely declarative — no implementation, no runtime imports
 * at module level. The spine logic lives in `spine.ts`.
 *
 * SUBSTRATE DISCIPLINE (N4: no new table):
 *   A portfolio run = 1 parent workstream (`workstreams.mode='portfolio'`).
 *   Per lane = 1 child workstream (`parent_workstream_id=<parent>`).
 *   Lane artifacts = `workstream_decisions` + `workspace_beliefs`.
 *   Stage completion = `workstream_decisions(decision_kind='route')` with
 *     rationale text that documents the stage transition. (decision_kind is
 *     CHECK-constrained in 0071; we reuse the 'route' kind and put the
 *     stage ID in rationale.)
 *
 * As of: 2026-05-29
 */

// ───────────────────────────────────────────────────────────────────────────
// Lane vocabulary
// ───────────────────────────────────────────────────────────────────────────

/**
 * The 7 lanes of the portfolio pipeline (verbatim from integration plan §4).
 *
 *   • communication-intake     — translates user input → source-event envelopes
 *                                + dependency hints. Nutrient for lanes 2–4.
 *   • expertise-compiler       — builds domain-specific expertise objects
 *                                from intake envelopes. Provides domain depth.
 *   • role-reverse-engineering — derives roles/decisions/dependencies from
 *                                real-world workflows.
 *   • innovation-mode          — reframes problems; provides the innovation
 *                                reframe model (stage 6).
 *   • toolstack-replacement    — evaluates existing tools and provides the
 *                                toolstack replacement model (stage 5).
 *   • mobile-ux                — provides the mobile surface model (stage 7).
 *   • governance               — provides the governance-gate contract (stage 1)
 *                                + the quality-gate validators.
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
 * Complete list of all lanes as a constant.
 * Used by the spine + tests + UI consumers as the source of truth.
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
 * Confidence behavior of a lane (integration plan §6).
 *
 *   • deterministic            — SQL/rule-only, no LLM, no human review.
 *   • llm-with-validation      — LLM output is checked with a deterministic
 *                                validator (N6 precedence).
 *   • llm-with-human-review    — output needs an explicit human-decision gate.
 */
export type ConfidenceBehavior =
  | 'deterministic'
  | 'llm-with-validation'
  | 'llm-with-human-review';

/**
 * Human-review requirement (integration plan §6).
 */
export type HumanReviewRequirement = 'none' | 'optional' | 'required';

/**
 * Lane contract — the 12 mandatory fields from integration plan §6.
 *
 * A contract is „complete" and „accepted" when:
 *   1. ALL 12 fields are present (no field undefined).
 *   2. List fields have at least 1 entry (no empty arrays).
 *      Exception: errorStates may be empty — a lane without failure modes
 *      is EXPLICITLY forbidden (integration plan §6: „keine Failure Modes
 *      benennt" → lane is rejected), so we require ≥1 here too.
 *
 * The fields mirror integration plan §6 1:1 — the order is
 * deliberately identical to the owner directive for an easy diff.
 */
export interface LaneContract {
  /** Event types this lane CONSUMES (input). */
  inputEvents: string[];
  /** Event types this lane EMITS (output). */
  outputEvents: string[];
  /** Tables/views it reads from or writes to. */
  dataSchema: string[];
  /** Permissions it needs (e.g. 'workspace:read', 'governance:write'). */
  permissionRequirements: string[];
  /** How it arrives at its statement (deterministic / llm-with-validator / human-review). */
  confidenceBehavior: ConfidenceBehavior;
  /** Whether a human-decision gate is mandatory before stage completion. */
  humanReviewRequirements: HumanReviewRequirement;
  /** Named error states (integration plan §6: „keine Failure Modes benennt" is forbidden). */
  errorStates: string[];
  /** Audit/provenance requirements (e.g. 'workstream_evidence row per retrieval'). */
  auditRequirements: string[];
  /** Surface kinds it shows in the chat (e.g. 'open-questions', 'plan-step'). */
  uxSurfaces: string[];
  /** Named metrics (e.g. 'intake_envelope_count', 'expertise_depth_score'). */
  metrics: string[];
  /** Test-fixture paths/names. */
  testFixtures: string[];
  /** Rollout constraints (e.g. 'dry-run only until owner LIVE-flip'). */
  rolloutConstraints: string[];
}

/**
 * Result of the contract check. Returned by the spine + the API.
 */
export interface LaneContractValidation {
  valid: boolean;
  /**
   * Verbatim complaints that are readable for the owner / critic loop.
   * Multiple issues possible (all 12 fields are checked, not just the first).
   */
  issues: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Merge Stages
// ───────────────────────────────────────────────────────────────────────────

/**
 * The 11 stages of the sequential merge sequence (master context §6).
 * The order is load-bearing — stage N may only merge when all
 * dependencies are complete (see MergeStage.requires).
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
 * Stage order is 1..11 (master context §6). The order is exported both
 * as a type constraint and as a constant.
 */
export type MergeStageOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export interface MergeStage {
  id: MergeStageId;
  order: MergeStageOrder;
  /** Which stages MUST be merged before this one may merge. */
  requires: MergeStageId[];
  /** Which lanes feed into this stage (output artifacts are consolidated here). */
  lanes: LaneId[];
  /** Which quality gates must pass BEFORE this stage may merge. */
  gates: QualityGateId[];
}

// ───────────────────────────────────────────────────────────────────────────
// Quality Gates
// ───────────────────────────────────────────────────────────────────────────

/**
 * The 6 quality gates from integration plan §7 (verbatim).
 *
 *   • G1 concept integrity     — Does the lane deliver a real concept (not a slide)?
 *   • G2 data readiness        — Are schema/events present?
 *   • G3 governance readiness  — Are there permissions/audit?
 *   • G4 workflow readiness    — Does the lane hang in the DAG?
 *   • G5 domain depth          — Does it have real domain logic (not generic
 *                                feature mush)?
 *   • G6 build readiness       — Is it testable/buildable?
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
  /** Verbatim question from integration plan §7. */
  question: string;
  /** Pure function — takes the run state, returns a result. Deterministic (N6). */
  validator: (state: PortfolioRunState) => QualityGateResult;
}

export interface QualityGateResult {
  passed: boolean;
  /** Verbatim rationale — mirrored into workstream_decisions.rationale. */
  reason: string;
  /** Concrete items still missing (e.g. lane IDs without a contract). */
  blockingItems: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Domain-eval context (G5 anti-MVP bridge)
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
  /** workstreams.id of the child workstream that physically represents this lane (NULL until spawn). */
  workstreamId: string | null;
  status: LaneRunStatus;
  /** Current contract state. NULL = not yet written. */
  contract: LaneContract | null;
  /** References to produced artifacts (workstream_decisions.id / workspace_beliefs.id / …). */
  artifactRefs: string[];
}

export interface PortfolioRunState {
  /** workstreams.id of the parent workstream (mode='portfolio'). */
  portfolioRunId: string;
  workspaceId: string;
  /** ms epoch. */
  startedAt: number;
  /** ONE entry per lane. Complete — even non-started lanes are tracked. */
  laneStates: Record<LaneId, LaneState>;
  /** Stages that are already merged. Strictly ascending (1..11). */
  completedMergeStages: MergeStageId[];
  /** Gates passed for at least one merge (informational; not persistent). */
  passedQualityGates: QualityGateId[];
  /** If a merge is currently blocked, the stage + verbatim reason here. */
  blockedAt: MergeStageId | null;
  blockedReason: string | null;
  /**
   * Optional domain-eval context. When set, G5 (domain depth) checks
   * REALLY against the compiled PV domain model instead of only against the
   * lane-contract heuristic. NULL/undefined = non-PV lane → G5 fallback.
   */
  domainEval?: DomainEvalContext | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers for validators + canMergeStage
// ───────────────────────────────────────────────────────────────────────────

export interface CanMergeStageResult {
  ok: boolean;
  /** Stages still missing (dependency violation). */
  blockingRequirements: MergeStageId[];
  /** Quality gates that are not passed. */
  blockingGates: QualityGateId[];
}
