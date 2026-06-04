/**
 * Sub-Plan-Sniper → StageDescriptor[] adapter (Sub-Plan 5 wave 2, 2026-05-01).
 *
 * Sniper fires sub-tickets from a master ticket. One stage per sub-ticket.
 * Heuristic from `inferSubStatus`:
 *
 *   - sub.closed === true                            → 'done'
 *   - workflowState === 'aborted' / 'failed'         → 'failed'
 *   - workflowState === 'skipped'                    → 'skipped'
 *   - workflowState === 'pending' / 'queued' / null  → 'pending'
 *   - otherwise (running/in-progress/dispatching)    → 'running'
 *
 * The heuristic is defensive: unknown states → 'pending'.
 */

import type { StageDescriptor } from '@/lib/ui/pip';

export interface SubTicketSnapshot {
  id: string;
  /** Readable title — if empty, fall back to the id suffix. */
  title?: string;
  /** Persisted workflowState from the tickets table. */
  workflowState?: string;
  closed: boolean;
}

const FAILED_STATES = new Set(['aborted', 'failed', 'error', 'cancelled']);
const SKIPPED_STATES = new Set(['skipped', 'irrelevant', 'merged']);
const RUNNING_STATES = new Set([
  'running',
  'in-progress',
  'in_progress',
  'dispatching',
  'spawned',
  'reviewing',
  'iterating',
  'roasting',
]);
const PENDING_STATES = new Set([
  'pending',
  'queued',
  'planned',
  'idle',
  'open',
  'todo',
]);

export function inferSubStatus(
  snap: SubTicketSnapshot,
): StageDescriptor['status'] {
  if (snap.closed) return 'done';
  const ws = snap.workflowState?.toLowerCase().trim();
  if (!ws) return 'pending';
  if (FAILED_STATES.has(ws)) return 'failed';
  if (SKIPPED_STATES.has(ws)) return 'skipped';
  if (RUNNING_STATES.has(ws)) return 'running';
  if (PENDING_STATES.has(ws)) return 'pending';
  // Unknown → defensively pending. But for "done" wording, treat as done.
  if (ws === 'done' || ws === 'completed' || ws === 'closed') return 'done';
  return 'pending';
}

export interface SniperProgressInput {
  masterTicketId: string;
  subs: ReadonlyArray<SubTicketSnapshot>;
}

/**
 * One stage per sub-ticket. Order stays as passed in (caller sorts).
 */
export function sniperToStages(input: SniperProgressInput): StageDescriptor[] {
  const { subs, masterTicketId } = input;
  return subs.map((snap, idx) => {
    const label =
      snap.title?.trim() ||
      (snap.id.length > 8 ? `Sub ${snap.id.slice(-6)}` : `Sub ${snap.id}`);
    return {
      id: `sniper::${masterTicketId}::${snap.id}`,
      label,
      status: inferSubStatus(snap),
      // Subtitle: raw workflowState as a mini hint, helps with debugging
      // in the live view without a drilldown.
      subtitle: snap.workflowState && !snap.closed ? snap.workflowState : undefined,
    };
  });
}
