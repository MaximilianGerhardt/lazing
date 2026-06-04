/**
 * auto-advance — FSM-Auto-Transitions für Tickets.
 *
 * Hintergrund (Handoff-Punkt 3):
 * Tickets dümpeln zu leicht, wenn Max sie manuell verschieben muss.
 * Dieses Modul automatisiert:
 *   1. Work-Product mit status=final → Ticket auto auf status=done
 *      (wenn Ticket noch open).
 *   2. Stale-Detection: Ticket status=open und älter als X Tage ohne
 *      Updates → tag 'stale' setzen. Ein dedizierter script/timer
 *      ruft checkStaleTickets täglich auf.
 *
 * Alle Transitions gehen durch `updateTicket()` im tickets/service,
 * sodass Events sauber emittiert werden (status_changed / updated)
 * und die Timeline zeigt, *warum* die Änderung kam (actor=system).
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
 * Wenn ein Work-Product in einen final-state geht, schliessen wir das
 * zugehörige Ticket, sofern es noch offen ist.
 *
 * Idempotent — wenn das Ticket bereits done/closed, NOP.
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
 * Findet Tickets mit status=open die seit `days` Tagen keinen Update
 * mehr gesehen haben, und markiert sie per Tag 'stale'. Idempotent:
 * wenn der Tag schon da ist, wird nichts emittiert.
 *
 * Gibt eine Liste der markierten Ticket-IDs zurück, damit der Caller
 * (typischerweise ein Cron-Script) das loggen kann.
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
