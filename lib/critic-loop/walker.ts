// Critic-Loop Walker.
//
// BACKPORT-03 from Lazing-V2 (2026-05-23 · Agent 3/8). Source:
// lazing-wt/realtime-orchestrator-v2/apps/web/src/lib/critic-loop/
// walker.ts (366 LOC, V2 Slice C).
//
// Lazyos-stable delta:
//   - V2 imports `requiredCapabilityNames` from `@lazing/runtime/engine/router`
//     and `SubagentHandoff`/`SubagentRole` from `@lazing/runtime/subagent`.
//     lazyos-stable has no monorepo split → we inline the small
//     `requiredCapabilityNames` map + the `SubagentHandoff` shape here.
//     R-02-A risk: if lazyos later gets a real runtime package,
//     this will be replaced with a direct import.
//
// Drives the recursive plan tree: depth-first traversal that gates
// every coder/architect step through the critic loop and lazily
// proposes deeper subplans when `subplanTrigger` fires.
//
// Single entry point: `runWalker(args)`. The walker yields lifecycle
// events as an async iterable so the SSE route can stream them; each
// event is also written to the substrate via the injected
// `WalkerHooks` so the trace tier (N8) carries the full execution
// history.

import {
  applyOperatorOverride,
  onFixIterStart,
  onLaneFinished,
  planStepStatusFromState,
  requireCritic,
  writeCriticRoundForStep,
  type CriticLoopContext,
  type CriticLoopState,
} from './critic-loop';
import type {
  CriticComment,
  CriticRepo,
  CriticVerdict,
} from './types';

import type { PlanStep, ProposedPlan } from '../plan-first/orchestrate-plan';
import {
  subplanTrigger,
  type CascadeMode,
  type PlanNode,
  type RecursivePlan,
} from '../plan-first/recursive-plan';

// ─── Subagent handoff types (inlined from V2 @lazing/runtime/subagent) ─────

export type SubagentRole = 'architect' | 'coder' | 'tester' | 'reviewer';

/**
 * Verbatim per-step handoff block that the walker passes into the
 * subagent system prompt. Mirrors V2's `SubagentHandoff` shape so a
 * future migration to a real runtime-package is a pure import swap.
 */
export interface SubagentHandoff {
  /** Verbatim operator intent (N1). */
  readonly mainPlanSummary: string;
  /** 1-based source-order of the step within the plan. */
  readonly stepIndex: number;
  /** Total steps in the plan node. */
  readonly totalSteps: number;
  readonly role: SubagentRole;
  /** Capability names the engine adapter expects this role to provide. */
  readonly requiredCapabilities: readonly string[];
  /** Artifacts produced by earlier siblings — passed verbatim. */
  readonly dependencies: ReadonlyArray<{ stepIndex: number; artifact: string }>;
  /** Verbatim 1-3 keyword artifacts THIS step is expected to produce. */
  readonly expectedArtifacts: readonly string[];
}

/**
 * Role-capability map — inlined from V2's `engine/role-capabilities.ts`
 * (single source of truth there; here it's a small constant). When
 * lazyos grows an explicit engine-router this should move there.
 */
const ROLE_CAPABILITIES: Readonly<Record<SubagentRole, readonly string[]>> = {
  architect: ['design', 'reason', 'plan'],
  coder: ['code', 'edit', 'diff'],
  tester: ['test', 'repro', 'verify'],
  reviewer: ['review', 'critique', 'audit'],
};

export function requiredCapabilityNames(role: SubagentRole): readonly string[] {
  return ROLE_CAPABILITIES[role];
}

// ─── Role-derived expected artifacts heuristic ──────────────────────────────

/**
 * Heuristic expectedArtifacts derivation when the LLM proposer didn't
 * emit any. Kept narrow on purpose — N1 says we prefer verbatim, so we
 * only fall back to a role-default when the proposer literally produced
 * nothing.
 */
function deriveExpectedArtifacts(step: PlanStep): readonly string[] {
  if (step.expectedArtifacts && step.expectedArtifacts.length > 0) {
    return step.expectedArtifacts;
  }
  switch (step.subagentRole) {
    case 'tester':
      return ['failing-test'];
    case 'coder':
      return ['code-diff'];
    case 'architect':
      return ['design-note'];
    case 'reviewer':
      return ['review-verdict'];
    default:
      return [];
  }
}

// ─── Hooks contract ─────────────────────────────────────────────────────────

export interface WalkerStepLaneResult {
  /** Verbatim diff body emitted by the coder lane (N1). */
  readonly diff: string;
}

export interface WalkerCriticResult {
  readonly verdict: CriticVerdict;
  readonly comments: readonly CriticComment[];
}

export interface WalkerHooks {
  /**
   * Execute the step's lane. The walker passes a structured `handoff`
   * block so the implementation can forward it verbatim into the
   * subagent system prompt.
   */
  readonly runStep: (
    step: PlanStep,
    iteration: number,
    handoff: SubagentHandoff,
  ) => Promise<WalkerStepLaneResult>;
  readonly proposeSubplan: (
    parent: PlanStep,
    depth: number,
  ) => Promise<ProposedPlan | null>;
  readonly runCritic: (
    step: PlanStep,
    iteration: number,
  ) => Promise<WalkerCriticResult>;
  readonly repo: CriticRepo;
  readonly writeUserOverride: (args: {
    readonly actionId: 'user_override_critic';
    readonly actionLabel: string;
    readonly workstreamId: string;
    readonly coordKey: string;
  }) => void;
  readonly now?: () => number;
  /**
   * Cascade mode — when `per-level`, the walker pauses BEFORE descending
   * into a subplan whose `awaitingApproval` flag is still true.
   */
  readonly cascadeMode?: CascadeMode;
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type WalkerEvent =
  | { readonly kind: 'step-start'; readonly stepId: string; readonly iteration: number }
  | {
      readonly kind: 'step-finished';
      readonly stepId: string;
      readonly iteration: number;
      readonly state: CriticLoopState;
    }
  | { readonly kind: 'subplan-proposed'; readonly parentStepId: string; readonly subplan: ProposedPlan }
  | {
      readonly kind: 'critic-verdict';
      readonly stepId: string;
      readonly iteration: number;
      readonly verdict: CriticVerdict;
    }
  | { readonly kind: 'escalated'; readonly stepId: string }
  | { readonly kind: 'cancelled'; readonly reason: string };

export interface WalkerArgs {
  readonly plan: RecursivePlan;
  readonly hooks: WalkerHooks;
  readonly workstreamId: string | null;
  readonly signal?: AbortSignal;
  /**
   * Optional per-step coordKey resolver. The walker prefers the
   * substrate plan-step row's coord_key; when not available (the
   * runtime hasn't synced the row yet) we fall back to
   * `${workstreamId}/plan-step:${stepId}` so INV-19 still holds.
   */
  readonly coordKeyFor?: (stepId: string) => string;
}

// ─── Walker ─────────────────────────────────────────────────────────────────

/**
 * Drive the recursive plan tree.
 *
 * Yields a `WalkerEvent` for every transition so the SSE route can
 * stream lane / critic events to the client. Internally the walker
 * threads a `CriticLoopState` per step and applies INV-16/17/18/19
 * via `critic-loop.ts`.
 */
export async function* runWalker(
  args: WalkerArgs,
): AsyncIterable<WalkerEvent> {
  const { plan, hooks, workstreamId, signal, coordKeyFor } = args;

  // DFS traversal of the recursive plan tree. We walk depth-first so a
  // step's subplan finishes before we move to the next sibling.
  for (const evt of []) yield evt; // type pin

  function defaultCoordKey(stepId: string): string {
    return `${workstreamId ?? 'no-ws'}/plan-step:${stepId}`;
  }

  function makeCtx(step: PlanStep): CriticLoopContext {
    return {
      stepId: step.id,
      coordKey: coordKeyFor?.(step.id) ?? defaultCoordKey(step.id),
      workstreamId,
      role: step.subagentRole,
    };
  }

  async function* walkNode(node: PlanNode, depth: number): AsyncIterable<WalkerEvent> {
    // Skip nodes that are explicitly awaiting per-level approval.
    if (node.awaitingApproval && hooks.cascadeMode === 'per-level') {
      yield {
        kind: 'cancelled',
        reason: `subplan-${node.id}-awaiting-per-level-approval`,
      };
      return;
    }
    // Track artifacts emitted by completed steps in this node so we can
    // populate downstream `dependencies` on later steps' handoff blocks.
    const completedArtifacts: { stepIndex: number; artifact: string }[] = [];

    for (const step of node.plan.steps) {
      if (signal?.aborted) {
        yield { kind: 'cancelled', reason: 'aborted' };
        return;
      }

      // 1. Subplan-trigger probe — if the step needs deeper recursion,
      //    propose / pull a subplan FIRST. The eager depth-1 children
      //    on `node.children` are reused if present; deeper depths use
      //    the lazy proposer.
      let subplan: ProposedPlan | null =
        node.children.get(step.id)?.plan ?? null;
      if (subplan === null && subplanTrigger(step, depth + 1)) {
        subplan = await hooks.proposeSubplan(step, depth + 1);
        if (subplan !== null) {
          yield {
            kind: 'subplan-proposed',
            parentStepId: step.id,
            subplan,
          };
        }
      }

      // 2. Execute the step lane + drive the critic loop.
      let state: CriticLoopState = { kind: 'executing', iteration: 0 };
      let iteration = 0;
      const ctx = makeCtx(step);
      let lastDiff = '';
      yield { kind: 'step-start', stepId: step.id, iteration };

      // Build the SubagentHandoff for this step. Verbatim from the
      // active RecursivePlan (N1) — mainPlanSummary echoes the
      // operator's intent; dependencies are pulled from the per-step
      // expectedArtifacts of earlier siblings.
      const expectedArtifacts = deriveExpectedArtifacts(step);
      const role: SubagentRole =
        (step.subagentRole as SubagentRole | undefined) ?? 'coder';
      const handoff: SubagentHandoff = {
        mainPlanSummary: plan.root.plan.originalIntent,
        stepIndex: step.index,
        totalSteps: node.plan.steps.length,
        role,
        requiredCapabilities: requiredCapabilityNames(role),
        dependencies: completedArtifacts.slice(),
        expectedArtifacts,
      };

      // Inner loop covers possible fix-iterations.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (signal?.aborted) {
          yield { kind: 'cancelled', reason: 'aborted' };
          return;
        }
        const laneResult = await hooks.runStep(step, iteration, handoff);
        lastDiff = laneResult.diff;
        // Lane finished → state transitions per INV-17 (tester/reviewer skip,
        // coder/architect enter critic-pending).
        const afterLane = onLaneFinished(ctx, state);
        state = afterLane.next;
        if (!requireCritic(step.subagentRole)) {
          yield {
            kind: 'step-finished',
            stepId: step.id,
            iteration,
            state,
          };
          break;
        }
        // INV-17 — critic gate required. Ask the critic, write the round,
        // branch on the verdict.
        const verdict = await hooks.runCritic(step, iteration);
        const after = writeCriticRoundForStep(
          ctx,
          state,
          verdict.verdict,
          verdict.comments,
          hooks.repo,
        );
        state = after.next;
        yield {
          kind: 'critic-verdict',
          stepId: step.id,
          iteration,
          verdict: verdict.verdict,
        };
        if (after.walkerHint === 'proceed') {
          yield {
            kind: 'step-finished',
            stepId: step.id,
            iteration,
            state,
          };
          break;
        }
        if (after.walkerHint === 'spawn-fix-iter') {
          // fix-pending → executing. Bump iteration counter and loop.
          state = onFixIterStart(state);
          iteration = state.kind === 'executing' ? state.iteration : iteration + 1;
          continue;
        }
        if (after.walkerHint === 'escalate') {
          yield { kind: 'escalated', stepId: step.id };
          yield {
            kind: 'step-finished',
            stepId: step.id,
            iteration,
            state,
          };
          // INV-18 — the route surfaces the escalation to the operator.
          // The walker stops descending into the subtree (escalations
          // are blocking).
          return;
        }
        // walkerHint === 'none' — defensive: shouldn't happen post-critic.
        break;
      }
      void lastDiff; // available for follow-up cross-roast hookup
      // Record this step's expected artifacts so subsequent siblings'
      // handoff blocks list them as dependencies.
      for (const artifact of expectedArtifacts) {
        completedArtifacts.push({ stepIndex: step.index, artifact });
      }
      // 3. Descend into subplan AFTER the step's own critic gate clears.
      const child = node.children.get(step.id);
      if (child !== undefined) {
        yield* walkNode(child, depth + 1);
      } else if (subplan !== null) {
        // Lazily-proposed subplan — synthesise a node on the fly.
        const lazyNode: PlanNode = {
          id: `${node.id}/lazy:${step.id}`,
          step,
          plan: subplan,
          depth: depth + 1,
          cascadeMode: hooks.cascadeMode ?? 'cascade',
          awaitingApproval: (hooks.cascadeMode ?? 'cascade') === 'per-level',
          children: new Map(),
        };
        yield* walkNode(lazyNode, depth + 1);
      }
    }
  }

  yield* walkNode(plan.root, 0);

  // No-op reference to keep the import alive when tree-shaking aggressively.
  void [planStepStatusFromState, applyOperatorOverride];
}
