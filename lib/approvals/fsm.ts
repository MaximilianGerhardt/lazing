/**
 * Approval FSM — pure logic, unit-testable.
 *
 * lazyOS is single-user: Max is requester AND approver. The FSM still models
 * the workflow explicitly so that:
 *   1. Timelines traceably show WHO approved and when.
 *   2. Agents can autonomously propose transitions without
 *      wrongly performing the approve step (which is user-only by default).
 *   3. Phase 6 (multi-user) needs no schema break.
 *
 * State graph:
 *
 *   draft ──request_approval──> review
 *   review ──approve──> approved
 *   review ──reject──> rejected
 *   approved ──execute──> executed
 *   executed ──close──> closed
 *   executed ──request_approval──> review      (rework cycle)
 *   rejected ──reopen──> draft
 *   draft / review / approved / executed ──reject──> rejected
 *
 * Actor rules:
 *   - request_approval: user OR agent
 *   - approve:          user only. Agents only with flag autoApprove=true
 *   - reject:           user only
 *   - execute:          user OR agent
 *   - close:            user OR agent (the latter typically after a success event)
 *   - reopen:           user only
 *
 * Event mapping: every transition maps to exactly one `eventType` from
 * `lib/events/types.ts`. The mapping table is the interface between
 * FSM and event log — new events require a mapping here, otherwise
 * `eventTypeFor` throws.
 */

import type { EventType } from "../events/types";

export type WorkflowState =
  | "draft"
  | "review"
  | "approved"
  | "executed"
  | "closed"
  | "rejected";

export type Transition =
  | "request_approval"
  | "approve"
  | "reject"
  | "execute"
  | "close"
  | "reopen";

export type Actor = "user" | "agent";

export interface TransitionFlags {
  /**
   * Allows an agent the approve step. Default false.
   * Set per agent definition (e.g. in a later agent
   * registry with `allowAutoapprove: true`).
   */
  autoApprove?: boolean;
}

export const ALL_STATES: readonly WorkflowState[] = [
  "draft",
  "review",
  "approved",
  "executed",
  "closed",
  "rejected",
] as const;

export const ALL_TRANSITIONS: readonly Transition[] = [
  "request_approval",
  "approve",
  "reject",
  "execute",
  "close",
  "reopen",
] as const;

export const DEFAULT_STATE: WorkflowState = "draft";

/**
 * Linear pipeline order — the 5 standard steps in chronological order.
 * `rejected` is an old path, does not belong in the linear display (own
 * banner/pill). Single source for both pipeline components
 * (`WorkflowPipeline.tsx` in the ticket detail + `LiveWorkflowSurface.tsx` in
 * the chat).
 */
export const PIPELINE_STATES: ReadonlyArray<
  Exclude<WorkflowState, "rejected">
> = ["draft", "review", "approved", "executed", "closed"] as const;

export const STATE_LABEL: Record<WorkflowState, string> = {
  draft: "Entwurf",
  review: "Review",
  approved: "Freigegeben",
  executed: "Ausgeführt",
  closed: "Geschlossen",
  rejected: "Abgelehnt",
};

export const STATE_HINT: Record<WorkflowState, string> = {
  draft: "Ticket ist in Bearbeitung",
  review: "Warte auf Freigabe",
  approved: "Bereit zur Ausführung",
  executed: "Abgeschlossen, prüfe Ergebnis",
  closed: "Archiviert",
  rejected: "Zurückgewiesen — reopen möglich",
};

// ---------------------------------------------------------------------------
// Transition-Graph
// ---------------------------------------------------------------------------

type Edge = {
  from: WorkflowState;
  transition: Transition;
  to: WorkflowState;
};

const EDGES: readonly Edge[] = [
  { from: "draft", transition: "request_approval", to: "review" },
  { from: "executed", transition: "request_approval", to: "review" }, // Rework
  { from: "review", transition: "approve", to: "approved" },
  { from: "approved", transition: "execute", to: "executed" },
  { from: "executed", transition: "close", to: "closed" },
  { from: "rejected", transition: "reopen", to: "draft" },

  // Reject is possible from almost any state. The only exception: closed
  // (closed tickets are no longer rejected — whoever needs changes
  // opens a new ticket).
  { from: "draft", transition: "reject", to: "rejected" },
  { from: "review", transition: "reject", to: "rejected" },
  { from: "approved", transition: "reject", to: "rejected" },
  { from: "executed", transition: "reject", to: "rejected" },
];

// ---------------------------------------------------------------------------
// Actor-Policy
// ---------------------------------------------------------------------------

function isActorAllowed(
  transition: Transition,
  actor: Actor,
  flags?: TransitionFlags,
): boolean {
  switch (transition) {
    case "approve":
      if (actor === "user") return true;
      return actor === "agent" && flags?.autoApprove === true;
    case "reject":
    case "reopen":
      return actor === "user";
    case "request_approval":
    case "execute":
    case "close":
      return true; // user ODER agent
    default: {
      // Exhaustiveness check
      const _never: never = transition;
      return _never;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a transition from the given state by the given actor
 * is allowed. Considers both the edge set and the actor policy.
 */
export function canTransition(
  from: WorkflowState,
  transition: Transition,
  actor: Actor,
  flags?: TransitionFlags,
): boolean {
  if (!isActorAllowed(transition, actor, flags)) return false;
  return EDGES.some(
    (e) => e.from === from && e.transition === transition,
  );
}

/**
 * Returns the successor state or `null` if the transition from the
 * given state is not defined (regardless of actor).
 */
export function nextState(
  from: WorkflowState,
  transition: Transition,
): WorkflowState | null {
  const edge = EDGES.find(
    (e) => e.from === from && e.transition === transition,
  );
  return edge ? edge.to : null;
}

/**
 * Event type for a transition. 1:1 mapping against `lib/events/types.ts`.
 * Throws if a transition has no mapping (programming error — should
 * be caught by the TypeScript exhaustiveness check).
 */
export function eventTypeFor(transition: Transition): EventType {
  switch (transition) {
    case "request_approval":
      return "approval_requested";
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "execute":
      return "executed";
    case "close":
      return "closed";
    case "reopen":
      return "reopened";
    default: {
      const _never: never = transition;
      throw new Error(`no event mapping for transition: ${String(_never)}`);
    }
  }
}

/**
 * Reverse mapping: derive the transition from an event type. Useful
 * for the projection that reconstructs the current state from the event log.
 * Non-FSM events (updated, commented, created, ...) return null.
 */
export function transitionForEvent(
  eventType: EventType,
): Transition | null {
  switch (eventType) {
    case "approval_requested":
      return "request_approval";
    case "approved":
      return "approve";
    case "rejected":
      return "reject";
    case "executed":
      return "execute";
    case "closed":
      return "close";
    case "reopened":
      return "reopen";
    default:
      return null;
  }
}

/**
 * Projects the current workflow state from a chronologically sorted
 * event list (oldest-first). Starts at `DEFAULT_STATE` ("draft") and
 * follows the FSM transitions. Events without a mapping are ignored (they
 * affect fields, not state). Disallowed transitions are
 * ignored (defensive — the event log could be inconsistent due to bugs or older
 * code versions; we do not crash the whole projection).
 */
export function projectStateFromEvents(
  events: ReadonlyArray<{ eventType: EventType }>,
): WorkflowState {
  let state: WorkflowState = DEFAULT_STATE;
  for (const ev of events) {
    const t = transitionForEvent(ev.eventType);
    if (!t) continue;
    const n = nextState(state, t);
    if (n) state = n;
  }
  return state;
}

/**
 * Returns the set of transitions possible from the given state via the
 * user actor. For UI rendering (e.g. only show "Freigeben" / "Ablehnen"
 * buttons when allowed).
 */
export function availableUserTransitions(
  from: WorkflowState,
): Transition[] {
  return ALL_TRANSITIONS.filter((t) =>
    canTransition(from, t, "user"),
  );
}

/**
 * Is the state a terminal state? (closed = definitive; rejected can switch
 * back to draft via reopen, so it is NOT final.)
 */
export function isTerminalState(state: WorkflowState): boolean {
  return state === "closed";
}
