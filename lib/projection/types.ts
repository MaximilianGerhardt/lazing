/**
 * Phase 1 Track E — state-projection spine.
 *
 * These types define the schema of the operational workspace state
 * that `projectWorkspaceState` derives from the DB truth tables
 * (workstreams · flow runs · plan steps · events · question_answers).
 *
 * CONTRACT (verbatim from finding D §10):
 *   - Source of truth: DB/event state, NOT visible chat surfaces.
 *   - Old surfaces in the history stay history; they never block
 *     the current run and are no state proof.
 *   - After reload the current operational state must be reconstructable
 *     exactly from these fields.
 *
 * This file is purely declarative — NO imports, NO implementation.
 */

/**
 * Status of an active FlowRun.
 *
 * The vocabulary is deliberately small and disjoint:
 *   - `pending` — flow_run created, not yet started
 *   - `running` — steps run (at least one active)
 *   - `needs-coupling` — a gate (e.g. coupling choice) blocks progress
 *   - `needs-style-choice` — a gate asks for a style choice
 *   - `done`     — all steps completed successfully
 *   - `failed`   — error in the current run
 *
 * Mapping in `state-projector.ts`:
 *   - flow_runs.status='pending'   → 'pending'
 *   - flow_runs.status='running'   → 'running' | 'needs-coupling' | 'needs-style-choice'
 *     (refinement via gate search)
 *   - flow_runs.status='done'      → 'done'
 *   - flow_runs.status='failed'    → 'failed'
 *   - flow_runs.status='cancelled' → 'failed'
 */
export type ActiveFlowRunStatus =
  | 'pending'
  | 'running'
  | 'needs-coupling'
  | 'needs-style-choice'
  | 'done'
  | 'failed';

export interface ActiveFlowRunState {
  flowRunId: string;
  /** Bridge to the tier orchestrator. */
  workstreamId: string;
  status: ActiveFlowRunStatus;
  /** Phase from the run-cockpit vocabulary — optional, derived from the active step title. */
  currentPhase?: string;
  /** ms epoch — flow_runs.created_at. */
  startedAt: number;
  /** ms epoch — max(flow_runs.updated_at, most recent step update). */
  lastEventAt: number;
}

export interface ActiveWorkstreamState {
  workstreamId: string;
  /** parent_workstream_id (NULL for master streams). */
  parent?: string;
  /** workstreams.name — N1: verbatim from DB. */
  name: string;
  /** workstreams.status — e.g. 'active' | 'paused' | 'done' | 'stuck'. */
  status: string;
  /** workstreams.role — e.g. 'lead' | 'roaster-1' | 'critic'. */
  role?: string;
}

export interface OpenQuestionState {
  /** Question set that bundles several related questions. */
  questionSetId: string;
  /** Stable ID within the question set. */
  questionId: string;
  /** Optional workstream reference (NULL = workspace-wide). */
  workstreamId?: string;
  /** N1: verbatim from payload.text — no .slice. */
  text: string;
  /** Multiple-choice options, NULL if free answer. */
  options?: string[];
  /** ms epoch of the emit. */
  askedAt: number;
  /**
   * true if an entry with the same (set,id) exists in `question_answers`.
   * The P1.AB track writes that; if the table is missing → always false (fail-soft).
   */
  answered: boolean;
}

/**
 * Vocabulary of the blocking gates from the ACL5 / owner directive:
 *   - `credential-request`     — credential missing, surface requests user input
 *   - `connector-call-preview` — live call waits for user approve
 *   - `live-warn`              — first call in LIVE mode (S6 trust-ask)
 *   - `counter-evidence`       — P13 devil's-advocate counter-evidence card
 *   - `human-decision`         — explicit human decision (e.g. cross-roast)
 *   - `decision`               — F18 (2026-05-30): an open decision /
 *                                quickchoice / tier-choice surface. Previously it
 *                                stayed as a card IN THE MIDDLE of the feed (critic: „nicht
 *                                gepinnt, ohne Aktions-Hierarchie, 4 gleichwertige
 *                                Optionen"). Now the projection captures it as a
 *                                blockingGate → the ActionDeck pins it below
 *                                over the chat with ONE recommended primary action.
 */
export type BlockingGateKind =
  | 'credential-request'
  | 'connector-call-preview'
  | 'live-warn'
  | 'counter-evidence'
  | 'human-decision'
  | 'decision';

/**
 * An option of a pinned decision/quickchoice (F18). Carries the verbatim
 * label (N1) + sub-label + whether it is the recommended primary action. The
 * ActionDeck renders exactly ONE recommended option filled/accent, the rest
 * as a quiet list (progressive disclosure) — instead of 4 equal-weight buttons.
 */
export interface GateOption {
  /** Stable ID within the surface (for data-recommended click routing). */
  id: string;
  /** N1: verbatim label from payload — no .slice. */
  label: string;
  /** Optional sub-label (verbatim). */
  sublabel?: string;
  /** true → recommended primary action (filled/accent). Exactly one per gate. */
  recommended?: boolean;
}

export interface BlockingGateState {
  kind: BlockingGateKind;
  workstreamId?: string;
  /** N1: verbatim description from payload (surface/reason). */
  description: string;
  /** ms epoch — events.created_at. */
  createdAt: number;
  /**
   * F18 (2026-05-30): the options of a pinned decision/quickchoice/
   * tier-choice. Only set for kind='decision' (otherwise undefined). Exactly one
   * option carries `recommended:true` (marked by the server or — if the
   * marking is missing — the first option as a deterministic default). Verbatim (N1).
   */
  options?: GateOption[];
}

export interface LastSuccessfulActionState {
  /** Vocabulary-free (e.g. 'lead-v1-done', 'roaster-converged', 'workflow.completed'). */
  kind: string;
  /** ms epoch. */
  at: number;
  /** Optional short description (N1: verbatim from payload, max 280 characters). */
  summary?: string;
}

/**
 * What the system is currently waiting for:
 *   - `free-prompt`     — the user may enter anything (default).
 *   - `answer-question` — an open question blocks; the UI should show the answer surface.
 *   - `approve-gate`    — a blocking gate (credential/preview) waits for user approve.
 *   - `wait`            — the run is going, no user input expected.
 */
export type NextAllowedUserInput =
  | 'free-prompt'
  | 'answer-question'
  | 'approve-gate'
  | 'wait';

export interface WorkspaceState {
  workspaceId: string;
  /** ms epoch — generation time. Not cacheable. */
  generatedAt: number;

  /** NULL if no flow_run is active in this workspace. */
  activeFlowRun: ActiveFlowRunState | null;

  /**
   * All workstreams with status='active' in the workspace.
   * Sorted by updated_at DESC.
   */
  activeWorkstreams: ActiveWorkstreamState[];

  /**
   * All open questions (chat_message events with surface 'open-questions'
   * or 'plan-open-questions'), joined with question_answers.
   * Sorted by askedAt DESC.
   */
  openQuestions: OpenQuestionState[];

  /**
   * Blocking gates from chat_message surfaces:
   * credential-request · connector-call-preview · live-warn ·
   * counter-evidence · human-decision.
   */
  blockingGates: BlockingGateState[];

  /** Most recent lifecycle event with a positive outcome in the workspace. */
  lastSuccessfulAction: LastSuccessfulActionState | null;

  /** Derived deterministically from the other fields. */
  nextAllowedUserInput: NextAllowedUserInput;
}
