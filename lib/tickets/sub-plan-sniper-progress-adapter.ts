/**
 * Sub-Plan-Sniper → StageDescriptor[]-Adapter (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Sniper feuert Sub-Tickets aus einem Master-Ticket. Pro Sub-Ticket eine
 * Stage. Heuristik aus `inferSubStatus`:
 *
 *   - sub.closed === true                            → 'done'
 *   - workflowState === 'aborted' / 'failed'         → 'failed'
 *   - workflowState === 'skipped'                    → 'skipped'
 *   - workflowState === 'pending' / 'queued' / null  → 'pending'
 *   - sonst (running/in-progress/dispatching)        → 'running'
 *
 * Die Heuristik ist defensiv: unbekannte States → 'pending'.
 */

import type { StageDescriptor } from '@/lib/ui/pip';

export interface SubTicketSnapshot {
  id: string;
  /** Lesbarer Titel — falls leer, fallback auf id-Suffix. */
  title?: string;
  /** Persisted workflowState aus tickets-Tabelle. */
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
  // Unbekannt → defensiv pending. Bei „done"-Wording aber als done.
  if (ws === 'done' || ws === 'completed' || ws === 'closed') return 'done';
  return 'pending';
}

export interface SniperProgressInput {
  masterTicketId: string;
  subs: ReadonlyArray<SubTicketSnapshot>;
}

/**
 * Stage pro Sub-Ticket. Reihenfolge bleibt wie übergeben (Caller sortiert).
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
      // Subtitle: rohen workflowState als Mini-Hint, hilft beim Debugging
      // im Live-View ohne Drilldown.
      subtitle: snap.workflowState && !snap.closed ? snap.workflowState : undefined,
    };
  });
}
