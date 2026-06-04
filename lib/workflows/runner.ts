/**
 * Workflow runner — Pattern 4 foundation (2026-05-01).
 *
 * Deterministic FSM evaluation. The runner ITSELF makes no LLM calls;
 * it only evaluates conditions + decides the transition. LLM spawn happens
 * via tier-orchestrator integration in Wave 3 (out of scope here).
 *
 * API:
 *   - runWorkflow(workflowId, runId, ctx) → evaluate current state, attempt
 *     transition. Returns { ok, status, fromState, toState?, failedConditions? }.
 *   - transitionTo(runId, newStateId) → forced transition (for UI/override
 *     with an allow flag). Writes persist + emits an event.
 *   - evaluateConditions(state, ctx, kind) → check pre|post.
 *
 * Stuck definition:
 *   - preCondition fail in current state → stuck (the predecessor did not
 *     deliver correctly)
 *   - postCondition fail in current state → no transition, stay in the state,
 *     status stays 'running' (LLM/spawner must deliver output). If the
 *     runner sees the same thing several times in a row, it is treated as
 *     stuck — this logic is minimal in Wave 1: a single run call
 *     with a failing post → status='running', return 'pending'. Wave 3
 *     tightens it with a stuck detector (analogous to the stuck-detector for workstreams).
 *   - no-transition-fits (all conditions false) → stuck
 */

import { emitEvent } from '@/lib/events/emit';
import type { WorkflowCondition, WorkflowDefinition, WorkflowState, StateContext, WorkflowRun } from './dsl';
import { findState } from './dsl';
import { getWorkflow } from './registry';
import { loadRun, updateState } from './store';

export type RunResultStatus =
  | 'transitioned' // ok, entered a new state
  | 'completed' // transitioned to __terminal__
  | 'pending' // postCondition not yet met, same state, no error
  | 'stuck'; // preCondition fail or no-transition-fits

export interface RunResult {
  ok: boolean;
  status: RunResultStatus;
  fromState: string;
  toState?: string;
  failedConditions?: ReadonlyArray<{ id: string; label: string; kind: 'pre' | 'post' }>;
}

export interface RunWorkflowOptions {
  /**
   * Test hook: alternative definition (skip registry lookup). If passed,
   * the runner uses this definition instead of `getWorkflow(run.workflowId)`.
   * Used for side-by-side versioning tests + manualOverride tests.
   */
  definitionOverride?: WorkflowDefinition;
}

// --------------------------------------------------------------------------
// Condition-Eval
// --------------------------------------------------------------------------

export async function evaluateConditions(
  conditions: ReadonlyArray<WorkflowCondition>,
  ctx: StateContext,
): Promise<{ ok: boolean; failed: ReadonlyArray<{ id: string; label: string }> }> {
  const failed: Array<{ id: string; label: string }> = [];
  for (const cond of conditions) {
    let result: boolean;
    try {
      result = await Promise.resolve(cond.check(ctx));
    } catch {
      result = false;
    }
    if (!result) {
      failed.push({ id: cond.id, label: cond.label });
    }
  }
  return { ok: failed.length === 0, failed };
}

// --------------------------------------------------------------------------
// Transition-Selection
// --------------------------------------------------------------------------

async function pickTransition<TStateId extends string>(
  state: WorkflowState<TStateId>,
  ctx: StateContext,
): Promise<{ to: TStateId | '__terminal__' } | null> {
  // Greedy: first transition whose condition is true (or that has none).
  for (const tr of state.transitions) {
    if (!tr.condition) {
      return { to: tr.to };
    }
    let ok = false;
    try {
      ok = await Promise.resolve(tr.condition(ctx));
    } catch {
      ok = false;
    }
    if (ok) return { to: tr.to };
  }
  return null;
}

// --------------------------------------------------------------------------
// Main function
// --------------------------------------------------------------------------

/**
 * Evaluates the current state of a run and tries to advance.
 * One call corresponds to one "tick". External callers (Wave 3 tier-
 * orchestrator) call this again after each LLM output.
 */
export async function runWorkflow(
  runId: string,
  ctx: Omit<StateContext, 'data'> & { data?: Record<string, unknown> },
  options: RunWorkflowOptions = {},
): Promise<RunResult> {
  const run = await loadRun(runId);
  if (!run) {
    throw new Error(`workflow run not found: ${runId}`);
  }

  const def =
    options.definitionOverride ??
    getWorkflow(run.workflowId, run.definitionVersion);
  if (!def) {
    throw new Error(`workflow definition not found: ${run.workflowId}@${run.definitionVersion}`);
  }

  const fromStateId = run.currentState;
  const state = findState(def, fromStateId);
  if (!state) {
    throw new Error(`workflow state not found: ${fromStateId} in ${def.id}@${def.version}`);
  }

  // Merge run.data ← ctx.data (the caller may supply a transient overlay; persist
  // stays at run.data when ctx.data is omitted).
  const fullCtx: StateContext = {
    workstreamId: ctx.workstreamId,
    workspaceId: ctx.workspaceId,
    data: { ...run.data, ...(ctx.data ?? {}) },
  };

  // 1. check preConditions
  const preResult = await evaluateConditions(state.preConditions, fullCtx);
  if (!preResult.ok) {
    await markStuck(run, fromStateId, 'pre', preResult.failed);
    return {
      ok: false,
      status: 'stuck',
      fromState: fromStateId,
      failedConditions: preResult.failed.map((f) => ({ ...f, kind: 'pre' as const })),
    };
  }

  // 2. check postConditions — if not met, we stay in the state
  const postResult = await evaluateConditions(state.postConditions, fullCtx);
  if (!postResult.ok) {
    // Persist data if a new state was passed
    if (ctx.data) {
      await updateState({
        runId,
        newData: fullCtx.data,
        bumpTransitionTs: false,
      });
    }
    return {
      ok: true,
      status: 'pending',
      fromState: fromStateId,
      failedConditions: postResult.failed.map((f) => ({ ...f, kind: 'post' as const })),
    };
  }

  // 3. choose a transition
  const tr = await pickTransition(state, fullCtx);
  if (!tr) {
    await markStuck(run, fromStateId, 'transition', [
      { id: 'no-transition-fits', label: 'Keine Transition-Bedingung passt' },
    ]);
    return {
      ok: false,
      status: 'stuck',
      fromState: fromStateId,
      failedConditions: [
        { id: 'no-transition-fits', label: 'Keine Transition-Bedingung passt', kind: 'post' },
      ],
    };
  }

  // 4. perform the transition
  const toStateId = tr.to;
  if (toStateId === '__terminal__') {
    await updateState({
      runId,
      newData: fullCtx.data,
      status: 'completed',
      bumpTransitionTs: true,
    });
    await emitWorkflowEvent(run, 'workflow.completed', {
      fromState: fromStateId,
      toState: '__terminal__',
    });
    return {
      ok: true,
      status: 'completed',
      fromState: fromStateId,
      toState: '__terminal__',
    };
  }

  await updateState({
    runId,
    newState: toStateId as string,
    newData: fullCtx.data,
    status: 'running',
    bumpTransitionTs: true,
  });
  await emitWorkflowEvent(run, 'workflow.transitioned', {
    fromState: fromStateId,
    toState: toStateId,
  });
  return {
    ok: true,
    status: 'transitioned',
    fromState: fromStateId,
    toState: toStateId as string,
  };
}

/**
 * Forced transition. Requires `manualOverride: 'allow'` on the current state.
 * On `'forbid'` the function throws and the caller must use the regular
 * runWorkflow().
 */
export async function transitionTo(
  runId: string,
  newStateId: string,
  options: RunWorkflowOptions = {},
): Promise<void> {
  const run = await loadRun(runId);
  if (!run) throw new Error(`workflow run not found: ${runId}`);

  const def =
    options.definitionOverride ??
    getWorkflow(run.workflowId, run.definitionVersion);
  if (!def) {
    throw new Error(`workflow definition not found: ${run.workflowId}@${run.definitionVersion}`);
  }

  const currentState = findState(def, run.currentState);
  if (!currentState) {
    throw new Error(`current state not found: ${run.currentState}`);
  }
  if (currentState.manualOverride === 'forbid') {
    throw new Error(
      `state ${currentState.id} has manualOverride='forbid' — cannot skip without satisfying postConditions`,
    );
  }

  const targetState = newStateId === '__terminal__' ? null : findState(def, newStateId);
  if (newStateId !== '__terminal__' && !targetState) {
    throw new Error(`target state not found: ${newStateId}`);
  }

  await updateState({
    runId,
    newState: newStateId,
    status: newStateId === '__terminal__' ? 'completed' : 'running',
    bumpTransitionTs: true,
  });
  await emitWorkflowEvent(
    run,
    newStateId === '__terminal__' ? 'workflow.completed' : 'workflow.transitioned',
    {
      fromState: run.currentState,
      toState: newStateId,
      forced: true,
    },
  );
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function markStuck(
  run: WorkflowRun,
  fromStateId: string,
  kind: 'pre' | 'post' | 'transition',
  failed: ReadonlyArray<{ id: string; label: string }>,
): Promise<void> {
  await updateState({
    runId: run.id,
    status: 'stuck',
    bumpTransitionTs: true,
  });
  await emitWorkflowEvent(run, 'workflow.stuck', {
    fromState: fromStateId,
    kind,
    failed,
  });
}

async function emitWorkflowEvent(
  run: WorkflowRun,
  eventType: 'workflow.started' | 'workflow.transitioned' | 'workflow.stuck' | 'workflow.completed',
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await emitEvent({
      segmentId: run.workspaceId ?? 'lazyos',
      entityType: 'workflow_run',
      entityId: run.id,
      eventType,
      actor: 'system',
      payload: {
        workflowId: run.workflowId,
        definitionVersion: run.definitionVersion,
        workstreamId: run.workstreamId,
        ...payload,
      },
      sensitivity: 'low',
    });
  } catch {
    // Event emit is best-effort. The workflow-run state is the truth;
    // the event is an audit trail. Don't mark stuck if the audit fails.
  }
}

/**
 * Convenience: emits a `workflow.started` event. Usually called
 * directly after createRun() by the API caller (Wave 2).
 */
export async function emitStartedEvent(run: WorkflowRun): Promise<void> {
  await emitWorkflowEvent(run, 'workflow.started', {
    initialState: run.currentState,
  });
}
