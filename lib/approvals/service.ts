/**
 * Approval-Service — FSM-Transition als Event emittieren.
 *
 * Server-side facade for the workflow API endpoint and internal
 * callers (e.g. agent callbacks that trigger `execute` or `close`).
 *
 * Contract:
 *   1. Load the current workflow state via ticket projection.
 *   2. Check FSM.canTransition(current, transition, actor, flags).
 *   3. If OK: emit an event with eventTypeFor(transition); payload contains
 *      `from`, `to`, optional `comment`, `previousState`.
 *   4. Re-project the ticket, return the new state + event.
 *   5. If NOT OK: throw InvalidTransitionError with detail info.
 */

import { emitEvent } from "../events/emit";
import { projectTicket } from "../events/project";
import type { ActorType, LazyEvent, TicketProjection } from "../events/types";
import {
  DEFAULT_STATE,
  canTransition,
  eventTypeFor,
  nextState,
  type Actor,
  type Transition,
  type TransitionFlags,
  type WorkflowState,
} from "./fsm";

export class TicketNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`ticket ${id} not found`);
    this.name = "TicketNotFoundError";
  }
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly ticketId: string,
    public readonly from: WorkflowState,
    public readonly transition: Transition,
    public readonly actor: Actor,
    public readonly reason:
      | "not_allowed_from_state"
      | "actor_not_permitted",
  ) {
    super(
      `invalid transition ${transition} from ${from} (actor=${actor}, reason=${reason})`,
    );
    this.name = "InvalidTransitionError";
  }
}

export interface WorkflowTransitionInput {
  transition: Transition;
  actor: ActorType;
  /** Free-text comment (lands in the event payload + timeline). */
  comment?: string;
  /** Agent flags — e.g. sets `autoApprove: true` for trusted agents. */
  flags?: TransitionFlags;
}

export interface WorkflowTransitionResult {
  ticket: TicketProjection;
  event: LazyEvent;
  previousState: WorkflowState;
  nextState: WorkflowState;
}

function asActor(a: ActorType): Actor {
  if (a === "system") return "user"; // system acts with user privileges
  if (a.startsWith("user:")) return "user";
  if (a.startsWith("agent:")) return "agent";
  // Defensive fallback — treat unknown actor shapes as "agent" to be
  // restrictive (agents have fewer rights than users).
  return "agent";
}

function currentWorkflowState(ticket: TicketProjection): WorkflowState {
  const s = ticket.workflowState;
  if (
    s === "draft" ||
    s === "review" ||
    s === "approved" ||
    s === "executed" ||
    s === "closed" ||
    s === "rejected"
  ) {
    return s;
  }
  return DEFAULT_STATE;
}

/**
 * Primary API: execute an FSM transition.
 */
export async function transitionWorkflow(
  ticketId: string,
  input: WorkflowTransitionInput,
): Promise<WorkflowTransitionResult> {
  const ticket = await projectTicket(ticketId);
  if (!ticket) throw new TicketNotFoundError(ticketId);

  const from = currentWorkflowState(ticket);
  const actor = asActor(input.actor);

  // 1) State policy: is this edge in the graph?
  const to = nextState(from, input.transition);
  if (!to) {
    throw new InvalidTransitionError(
      ticketId,
      from,
      input.transition,
      actor,
      "not_allowed_from_state",
    );
  }

  // 2) Actor-Policy
  if (!canTransition(from, input.transition, actor, input.flags)) {
    throw new InvalidTransitionError(
      ticketId,
      from,
      input.transition,
      actor,
      "actor_not_permitted",
    );
  }

  // 3) Emit event
  const eventType = eventTypeFor(input.transition);
  const payload: Record<string, unknown> = {
    from,
    to,
    transition: input.transition,
  };
  if (input.comment && input.comment.trim().length > 0) {
    payload.comment = input.comment.trim().slice(0, 2000);
  }
  if (input.flags?.autoApprove) {
    payload.autoApproved = true;
  }

  const event = await emitEvent({
    segmentId: ticket.segmentId,
    entityType: "ticket",
    entityId: ticketId,
    eventType,
    actor: input.actor,
    payload,
    sensitivity: "low",
  });

  // 4) Re-project
  const updated = await projectTicket(ticketId);
  if (!updated) throw new TicketNotFoundError(ticketId);

  return {
    ticket: updated,
    event,
    previousState: from,
    nextState: to,
  };
}

/**
 * Convenience: current workflow state (without a transition).
 */
export async function getWorkflowState(
  ticketId: string,
): Promise<WorkflowState> {
  const t = await projectTicket(ticketId);
  if (!t) throw new TicketNotFoundError(ticketId);
  return currentWorkflowState(t);
}
