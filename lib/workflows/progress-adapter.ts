/**
 * Workflow run → StageDescriptor[] adapter (Sub-Plan 5 Wave 2, 2026-05-01).
 *
 * Takes a `WorkflowRun` + its `WorkflowDefinition` and delivers the
 * stage list that `<Pipeline>` from `lib/ui/pip` can render.
 *
 * Mapping rules:
 *
 *   - definition.states is walked in order (source of truth).
 *   - active state (run.currentState) → 'running'.
 *   - all states before → 'done' (FSM is linear-monotonic; for branching
 *     a heuristic would be needed — no workflow in the repo branches at present).
 *   - all states after → 'pending'.
 *   - run.status='aborted' and active state reached → the active state
 *     gets 'failed' instead of 'running'.
 *   - run.status='completed' → ALL states 'done'.
 *   - manualOverride='forbid' states that were skipped (theoretically
 *     impossible, but defensive) stay 'pending'.
 *
 * Subtitle:
 *   - state.label becomes Stage.label.
 *   - On active state + run.status='stuck' → "stuck — Operator-Intervention".
 *
 * etaBucket:
 *   - active state: based on time since lastTransitionAt
 *       < 60s    → 'fast'
 *       < 5 min  → 'normal'
 *       < 30 min → 'slow'
 *       otherwise → 'overdue'
 *   - other states: undefined.
 *
 * Out-of-scope:
 *   - Sub-state expansion (state.llmSlot, etc.) — can be added later as sub[],
 *     currently too UI-speculative.
 */

import type { StageDescriptor, EtaBucket } from '@/lib/ui/pip';
import type { WorkflowRun, WorkflowDefinition } from './dsl';

const NOW_60S = 60_000;
const NOW_5MIN = 5 * 60_000;
const NOW_30MIN = 30 * 60_000;

function bucketForElapsed(elapsedMs: number): EtaBucket {
  if (elapsedMs < NOW_60S) return 'fast';
  if (elapsedMs < NOW_5MIN) return 'normal';
  if (elapsedMs < NOW_30MIN) return 'slow';
  return 'overdue';
}

export interface WorkflowProgressOptions {
  /** Override for `Date.now()` — test hook. */
  nowMs?: number;
}

export function workflowRunToStages(
  run: WorkflowRun,
  def: WorkflowDefinition,
  opts: WorkflowProgressOptions = {},
): StageDescriptor[] {
  const now = opts.nowMs ?? Date.now();
  const states = def.states;
  const activeIdx = states.findIndex((s) => s.id === run.currentState);
  const completed = run.status === 'completed';
  const aborted = run.status === 'aborted';
  const stuck = run.status === 'stuck';

  return states.map((state, idx) => {
    const isActive = idx === activeIdx;
    const isBeforeActive = activeIdx >= 0 && idx < activeIdx;
    const isAfterActive = activeIdx < 0 || idx > activeIdx;

    // Status mapping
    let status: StageDescriptor['status'];
    if (completed) {
      status = 'done';
    } else if (isBeforeActive) {
      status = 'done';
    } else if (isActive) {
      status = aborted ? 'failed' : 'running';
    } else if (isAfterActive) {
      status = 'pending';
    } else {
      status = 'pending';
    }

    // Subtitle / eta only for active
    let subtitle: string | undefined;
    let etaBucket: EtaBucket | undefined;
    if (isActive && !completed) {
      if (stuck) {
        subtitle = 'stuck — Operator-Intervention';
        etaBucket = 'overdue';
      } else if (aborted) {
        subtitle = 'abgebrochen';
      } else {
        const elapsed = Math.max(0, now - run.lastTransitionAt);
        etaBucket = bucketForElapsed(elapsed);
      }
    }

    return {
      id: `${def.id}::${state.id}`,
      label: state.label,
      status,
      subtitle,
      etaBucket,
    };
  });
}
