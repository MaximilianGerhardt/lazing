/**
 * auto-advance — FSM auto-transitions for tickets.
 *
 * Background (handoff point 3):
 * Tickets stall too easily when Max has to move them manually.
 * This module automates:
 *   1. Work-product with status=final → ticket auto to status=done
 *      (if the ticket is still open).
 *   2. Stale detection: ticket status=open and older than X days without
 *      updates → set tag 'stale'. A dedicated script/timer
 *      calls checkStaleTickets daily.
 *
 * All transitions go through `updateTicket()` in tickets/service,
 * so events are emitted cleanly (status_changed / updated)
 * and the timeline shows *why* the change happened (actor=system).
 */

import type { ActorType } from '../events/types';
import { projectTickets } from '../events/project';
import { TicketNotFoundError, getTicket, updateTicket } from './service';

const SYSTEM_ACTOR: ActorType = 'system';

export interface AutoAdvanceResult {
  ticketId: string;
  from: string;
  to: string;
  reason: string;
}

/**
 * When a work-product goes into a final state, we close the
 * associated ticket, provided it is still open.
 *
 * Idempotent — if the ticket is already done/closed, NOP.
 */
export async function autoAdvanceOnWorkProductFinal(
  ticketId: string,
): Promise<AutoAdvanceResult | null> {
  try {
    const ticket = await getTicket(ticketId);
    if (!ticket) return null;
    if (ticket.status === 'done') return null;

    await updateTicket(ticketId, {
      status: 'done',
      actor: SYSTEM_ACTOR,
      workflowState: ticket.workflowState === 'approved' ? 'executed' : ticket.workflowState,
    });

    return {
      ticketId,
      from: ticket.status,
      to: 'done',
      reason: 'work-product-final',
    };
  } catch (err) {
    if (err instanceof TicketNotFoundError) return null;
    throw err;
  }
}

/**
 * Finds tickets with status=open that have not seen an update for
 * `days` days, and marks them with the tag 'stale'. Idempotent:
 * if the tag is already there, nothing is emitted.
 *
 * Returns a list of the marked ticket IDs so the caller
 * (typically a cron script) can log it.
 */
export async function checkStaleTickets(
  days = 14,
  workspaceId?: string,
): Promise<AutoAdvanceResult[]> {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = await projectTickets(workspaceId);
  const out: AutoAdvanceResult[] = [];

  for (const t of all) {
    if (t.status !== 'open') continue;
    if (t.updatedAt > threshold) continue;
    if (t.tags.includes('stale')) continue;

    const nextTags = [...t.tags, 'stale'];
    try {
      await updateTicket(t.id, {
        tags: nextTags,
        actor: SYSTEM_ACTOR,
      });
      out.push({
        ticketId: t.id,
        from: 'fresh',
        to: 'stale',
        reason: `no-activity-${days}d`,
      });
    } catch (err) {
      if (err instanceof TicketNotFoundError) continue;
      throw err;
    }
  }

  return out;
}
