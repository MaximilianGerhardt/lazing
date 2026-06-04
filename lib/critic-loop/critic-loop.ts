// Critic-Loop state machine.
//
// BACKPORT-03 von Lazing-V2 (2026-05-23 · Agent 3/8). Quelle:
// lazing-wt/realtime-orchestrator-v2/apps/web/src/lib/critic-loop/
// critic-loop.ts (366 LOC, V2 Slice C).
//
// State diagram:
//
//   pending
//     → executing
//       → critic-pending
//         → resolved           (verdict = pass)
//         → fix-pending        (verdict = conditional, iter < MAX_CRITIC_FIX_ITERATIONS)
//           → executing        (operator/coder iterates)
//         → failed-escalated   (verdict = fail OR iter = MAX_CRITIC_FIX_ITERATIONS)
//           → resolved         (operator override — INV-18)
//           → cancelled        (operator abandons)
//
// Invariants (enforced in code, not comments — INV-16/17/18/19):
//
//   INV-16  Max 2 fix-iterations. The third critic-pending → conditional
//           transition becomes failed-escalated regardless of verdict.
//           Enforced at writeCriticRoundForStep (the iteration-cap branch).
//
//   INV-17  Every coder/architect step transitions THROUGH critic-pending
//           before reaching resolved. Testers + reviewers are exempt
//           (they ARE the critic role; gating their output through
//           another critic loops the system). Enforced at requireCritic()
//           + onLaneFinished().
//
//   INV-18  Operator override at failed-escalated writes a
//           `user_override_critic` row in workstream_decisions.
//           Enforced at applyOperatorOverride().
//
//   INV-19  Critic lane uses the SAME ManifestCoord as the coder lane
//           (no parallel scope envelope; N2 — fail-closed retrieval).
//           Enforced at writeCriticRoundForStep — the call site
//           threads `step.coordKey` straight through.

import type {
  CriticComment,
  CriticRepo,
  CriticRoundRow,
  CriticVerdict,
} from './types';

import type { PlanStep, PlanSubagentRole } from '../plan-first/orchestrate-plan';

// ─── Invariant constants ────────────────────────────────────────────────────

/** INV — depth cap (mirrors recursive-plan.MAX_SUBPLAN_DEPTH). */
export const MAX_SUBPLAN_DEPTH = 3 as const;

/**
 * INV-16 — maximum number of fix-iterations after the initial critic
 * round. iter=0 is the first critic gate; iter=1 + iter=2 are the two
 * permitted fix-iterations. iter=3+ is impossible — the loop escalates.
 */
export const MAX_CRITIC_FIX_ITERATIONS = 2 as const;

/**
 * INV-17 — roles whose output requires critic gating before resolution.
 * Testers + reviewers are exempt: gating their output through another
 * critic would create an infinite review loop.
 */
const CRITIC_REQUIRED_ROLES: ReadonlySet<PlanSubagentRole> = new Set<PlanSubagentRole>([
  'coder',
  'architect',
]);

/** INV-17 — exempt roles (not gated by critic loop). */
export const CRITIC_ROLES_EXEMPT = ['tester', 'reviewer'] as const;

// ─── State + transitions ────────────────────────────────────────────────────

export type CriticLoopState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'executing'; readonly iteration: number }
  | { readonly kind: 'critic-pending'; readonly iteration: number }
  | {
      readonly kind: 'fix-pending';
      readonly iteration: number;
      readonly lastVerdict: 'conditional';
    }
  | { readonly kind: 'resolved'; readonly finalRoundId: string | null }
  | {
      readonly kind: 'failed-escalated';
      readonly iteration: number;
      readonly lastVerdict: CriticVerdict;
    }
  | { readonly kind: 'cancelled' };

export interface CriticLoopContext {
  readonly stepId: string;
  readonly coordKey: string;
  readonly workstreamId: string | null;
  readonly role: PlanSubagentRole | undefined;
}

/**
 * Walker / orchestrator-side helper. The state machine is intentionally
 * pure — every transition takes (state, event) → state. Substrate
 * writes happen through the injected `CriticRepo`; this module returns
 * the new state + any side-effect that the caller (walker) must
 * perform (e.g. spawn a coder retry).
 */
export interface CriticLoopAdvanceResult {
  readonly next: CriticLoopState;
  readonly persisted: CriticRoundRow | null;
  /**
   * Returned to the walker so it can act on the verdict:
   *   - `proceed`        : caller should continue downstream lanes.
   *   - `spawn-fix-iter` : caller should re-spawn the coder lane.
   *   - `escalate`       : caller should surface the failed-escalated
   *                        state to the operator.
   *   - `none`           : no walker action required.
   */
  readonly walkerHint: 'proceed' | 'spawn-fix-iter' | 'escalate' | 'none';
}

/**
 * INV-17 — does this step's role require a critic gate?
 *
 * Returns true for `coder` + `architect`. Returns false (i.e. NO critic
 * required) for `tester`, `reviewer`, or undefined role.
 */
export function requireCritic(role: PlanSubagentRole | undefined): boolean {
  if (role === undefined) return false;
  return CRITIC_REQUIRED_ROLES.has(role);
}

/**
 * Step lifecycle entrypoint — the walker calls this when a coder lane
 * finishes streaming. If the role doesn't require a critic gate
 * (INV-17), the loop transitions straight to resolved.
 *
 * Returns the next state + a hint for the walker.
 */
export function onLaneFinished(
  ctx: CriticLoopContext,
  state: CriticLoopState,
): CriticLoopAdvanceResult {
  // Tester / reviewer / undefined-role lanes skip the critic gate.
  if (!requireCritic(ctx.role)) {
    return {
      next: { kind: 'resolved', finalRoundId: null },
      persisted: null,
      walkerHint: 'proceed',
    };
  }
  // Coder / architect lane → enter critic-pending. The iteration
  // counter is preserved from the prior state (fix-pending) or starts
  // at 0 on the first pass.
  const iter = currentIteration(state);
  return {
    next: { kind: 'critic-pending', iteration: iter },
    persisted: null,
    walkerHint: 'none',
  };
}

/**
 * Critic verdict arrived — write the round + advance the state.
 *
 * INV-16 — when the iteration count reaches MAX_CRITIC_FIX_ITERATIONS
 * AND the verdict is `conditional`, we escalate instead of looping again.
 *
 * INV-19 — the persisted round carries `ctx.coordKey` so the critic
 * round lives in the SAME scope envelope as the coder lane.
 */
export function writeCriticRoundForStep(
  ctx: CriticLoopContext,
  state: CriticLoopState,
  verdict: CriticVerdict,
  comments: readonly CriticComment[],
  repo: CriticRepo,
  criticRole: 'critic' | 'cross-roast' = 'critic',
): CriticLoopAdvanceResult {
  if (state.kind !== 'critic-pending') {
    throw new Error(
      `writeCriticRoundForStep: state must be 'critic-pending' (got '${state.kind}')`,
    );
  }
  const iteration = state.iteration;
  const { row } = repo.writeCriticRound({
    planStepId: ctx.stepId,
    iteration,
    verdict,
    comments,
    criticRole,
    coordKey: ctx.coordKey, // INV-19 — same coord as coder lane.
    workstreamId: ctx.workstreamId,
  });

  if (verdict === 'pass') {
    return {
      next: { kind: 'resolved', finalRoundId: row.id },
      persisted: row,
      walkerHint: 'proceed',
    };
  }
  if (verdict === 'fail') {
    return {
      next: { kind: 'failed-escalated', iteration, lastVerdict: 'fail' },
      persisted: row,
      walkerHint: 'escalate',
    };
  }
  // verdict === 'conditional' OR 'superseded' (the second is a marker
  // for the repo — we shouldn't see it on a fresh write, but be safe).
  if (verdict === 'conditional') {
    // INV-16 — cap fix iterations at MAX_CRITIC_FIX_ITERATIONS.
    if (iteration >= MAX_CRITIC_FIX_ITERATIONS) {
      return {
        next: { kind: 'failed-escalated', iteration, lastVerdict: 'conditional' },
        persisted: row,
        walkerHint: 'escalate',
      };
    }
    return {
      next: {
        kind: 'fix-pending',
        iteration: iteration + 1,
        lastVerdict: 'conditional',
      },
      persisted: row,
      walkerHint: 'spawn-fix-iter',
    };
  }
  // Defensive — 'superseded' shouldn't end up here. Treat as escalation.
  return {
    next: { kind: 'failed-escalated', iteration, lastVerdict: verdict },
    persisted: row,
    walkerHint: 'escalate',
  };
}

/**
 * Walker calls this when a coder fix-iteration spawns. State machine
 * transitions fix-pending → executing.
 */
export function onFixIterStart(state: CriticLoopState): CriticLoopState {
  if (state.kind !== 'fix-pending') {
    throw new Error(`onFixIterStart: state must be 'fix-pending' (got '${state.kind}')`);
  }
  return { kind: 'executing', iteration: state.iteration };
}

/**
 * INV-18 — operator override at failed-escalated.
 *
 * Writes the override decision row through the substrate repo (the
 * caller is responsible for plumbing the workstream decisions writer)
 * and transitions the loop to `resolved`. Returns the round id used
 * for the override (or null if no prior round exists).
 *
 * The caller MUST pass a `writeUserOverride` callback that writes the
 * decision row; this module doesn't reach across module boundaries
 * directly because the test suite runs without a full repo plumbed.
 */
export interface OperatorOverrideInput {
  readonly ctx: CriticLoopContext;
  readonly state: CriticLoopState;
  /** Verbatim operator note explaining the override — N1, no slice. */
  readonly note: string;
  /** Bound by the caller to the real `Repo.writeDecision` write. */
  readonly writeUserOverride: (args: {
    readonly actionId: 'user_override_critic';
    readonly actionLabel: string;
    readonly workstreamId: string;
    readonly coordKey: string;
  }) => void;
}

/**
 * Apply the operator override at failed-escalated. Returns the next state.
 *
 * Enforces INV-18 by ALWAYS writing the `user_override_critic` decision
 * row via the injected callback. Refuses to run from any state other
 * than failed-escalated so an operator can't accidentally short-circuit
 * a passing critic.
 */
export function applyOperatorOverride(
  input: OperatorOverrideInput,
): CriticLoopState {
  if (input.state.kind !== 'failed-escalated') {
    throw new Error(
      `applyOperatorOverride: state must be 'failed-escalated' (got '${input.state.kind}')`,
    );
  }
  if (input.ctx.workstreamId === null) {
    throw new Error(
      'applyOperatorOverride: workstreamId is required to write the user-override decision row',
    );
  }
  // INV-18 — write the user_override_critic decision row VERBATIM (N1).
  input.writeUserOverride({
    actionId: 'user_override_critic',
    actionLabel: input.note, // verbatim operator note
    workstreamId: input.ctx.workstreamId,
    coordKey: input.ctx.coordKey, // INV-19 — same coord as the loop.
  });
  return { kind: 'resolved', finalRoundId: null };
}

/**
 * Cancel the loop from any non-terminal state. Used when the operator
 * abandons the step entirely.
 */
export function cancelLoop(state: CriticLoopState): CriticLoopState {
  if (state.kind === 'resolved' || state.kind === 'cancelled') return state;
  return { kind: 'cancelled' };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function currentIteration(state: CriticLoopState): number {
  if (state.kind === 'executing') return state.iteration;
  if (state.kind === 'critic-pending') return state.iteration;
  if (state.kind === 'fix-pending') return state.iteration;
  if (state.kind === 'failed-escalated') return state.iteration;
  return 0;
}

/**
 * Walker-facing convenience for "did this step finish through the
 * critic gate?" — useful when assembling the step's surface-side
 * status (e.g. badge: "fix-iter-1", "escalated").
 */
export function statusFromState(state: CriticLoopState): string {
  switch (state.kind) {
    case 'pending':
      return 'pending';
    case 'executing':
      return state.iteration > 0 ? `fix-iter-${state.iteration}` : 'active';
    case 'critic-pending':
      return 'in-critic';
    case 'fix-pending':
      return `fix-iter-${state.iteration}`;
    case 'failed-escalated':
      return 'escalated';
    case 'resolved':
      return 'done';
    case 'cancelled':
      return 'cancelled';
  }
}

/**
 * Walker convenience: project a step + state into the PlanSurface row
 * status that the renderer understands.
 */
export function planStepStatusFromState(
  state: CriticLoopState,
): 'done' | 'active' | 'pending' | 'failed' {
  switch (state.kind) {
    case 'pending':
      return 'pending';
    case 'executing':
    case 'critic-pending':
    case 'fix-pending':
      return 'active';
    case 'resolved':
      return 'done';
    case 'failed-escalated':
    case 'cancelled':
      return 'failed';
  }
}

// Suppress unused warning when callers only consume types.
void ([] as readonly PlanStep[]);
