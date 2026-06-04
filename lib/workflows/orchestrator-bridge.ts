/**
 * Workflow orchestrator bridge — Pattern 4 Wave 2.4 (2026-05-01).
 *
 * Connects workstreams with workflow runs WITHOUT heavily reworking the
 * tier-orchestrator. Functions:
 *
 *   findActiveWorkflowRunForWorkstream(workstreamId)
 *     → first running/stuck workflow_run, or null.
 *
 *   shouldUseWorkflowFsm(workstreamId)
 *     → boolean. true if an active run is attached AND the definition
 *       is implemented (not a stub).
 *
 *   advanceWorkflowFromOrchestrator(runId, ctx, dataPatch?)
 *     → calls runWorkflow() with a data patch. The caller (tier-orchestrator)
 *       delivers the mapping LLM-result→run-data after each LLM output and
 *       gets back whether the next state is due (transitioned),
 *       we are still in the same state (pending) or stuck.
 *
 * Backwards-compat: untagged workstreams (without an attached run) continue
 * with the existing free iterate loop. The bridge is purely
 * additive.
 *
 * Wave 3 (a later sub-sprint) merges the mapping LLM-result→run-data
 * with the state promptTemplates / outputSchemas. Wave 2.4 here only delivers
 * the lookup and the thin API.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { workflowRuns } from '@/db/schema/workflow_runs';
import { emitEvent } from '@/lib/events/emit';
import { findState, type WorkflowRun } from './dsl';
import { getWorkflow } from './registry';
import { runWorkflow, type RunResult } from './runner';
import { loadRun } from './store';

export async function findActiveWorkflowRunForWorkstream(
  workstreamId: string,
): Promise<WorkflowRun | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workstreamId, workstreamId),
        inArray(workflowRuns.status, ['running', 'stuck']),
      ),
    )
    .orderBy(desc(workflowRuns.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return loadRun(row.id);
}

export async function shouldUseWorkflowFsm(
  workstreamId: string,
): Promise<{ useFsm: false } | { useFsm: true; runId: string; workflowId: string }> {
  const run = await findActiveWorkflowRunForWorkstream(workstreamId);
  if (!run) return { useFsm: false };
  const def = getWorkflow(run.workflowId, run.definitionVersion);
  if (!def) return { useFsm: false };
  // Stub filter: 1-state 'noop' → no FSM needed.
  if (def.states.length === 1 && def.states[0]?.id === 'noop') {
    return { useFsm: false };
  }
  // If the state in the run no longer exists (definition drift), take the
  // safer path: no FSM switch, continue with the existing loop.
  if (!findState(def, run.currentState)) return { useFsm: false };
  return { useFsm: true, runId: run.id, workflowId: run.workflowId };
}

/**
 * Convenience: calls runWorkflow() with an optional data patch. If the state
 * has postConditions that are not yet met, returns `pending` and the
 * caller can re-spawn the same state.
 */
export async function advanceWorkflowFromOrchestrator(args: {
  runId: string;
  workspaceId: string;
  workstreamId: string;
  dataPatch?: Record<string, unknown>;
}): Promise<RunResult> {
  return runWorkflow(args.runId, {
    workspaceId: args.workspaceId,
    workstreamId: args.workstreamId,
    data: args.dataPatch,
  });
}

/**
 * Audit event for the tier-orchestrator hook. Best-effort, blocks nothing.
 */
export async function emitWorkflowTickAudit(args: {
  workspaceId: string;
  workstreamId: string;
  runId: string;
  workflowId: string;
  result: RunResult;
}): Promise<void> {
  try {
    await emitEvent({
      segmentId: args.workspaceId,
      entityType: 'workflow_run',
      entityId: args.runId,
      eventType: 'updated',
      actor: 'system',
      payload: {
        kind: 'workflow.orchestrator-tick',
        workflowId: args.workflowId,
        workstreamId: args.workstreamId,
        result: {
          ok: args.result.ok,
          status: args.result.status,
          fromState: args.result.fromState,
          toState: args.result.toState,
        },
      },
      sensitivity: 'low',
    });
  } catch {
    // ignore — audit must not stop the loop.
  }
}
