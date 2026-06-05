/**
 * Ticket handoff derivation — "Wer ist dran?" ("Who is up?").
 *
 * Pure logic, unit-testable. Derives — from the FSM workflow state plus
 * the last actor who performed an FSM transition — a single human-readable
 * line that answers the operator's first question on any autonomous ticket:
 * *do I need to do something, or is the swarm still working?*
 *
 * Why this matters (SP-11): the backend is real — event-sourced, an FSM with
 * agent↔human transitions (`lib/approvals/fsm.ts`), and an auto-advance cron.
 * But that autonomy is invisible if the UI just shows a state badge. This
 * module turns the FSM + event log into a legible handoff signal:
 *
 *   - state=review  & last actor=agent  → "Agent wartet auf deine Freigabe"
 *     (you must approve — agents cannot approve themselves by default).
 *   - state=executed & last actor=agent → "Agent hat ausgeführt — Ergebnis prüfen"
 *   - state=approved & last actor=user  → "Bereit — Agent kann ausführen"
 *   - …
 *
 * It also surfaces an *open* `answer_required` event (emitted by
 * plan-dispatch / auto-connect via `lib/push/triggers.emitAnswerRequired`)
 * as the highest-priority "braucht dich" signal, because that is an explicit
 * request for an answer that blocks the run.
 *
 * No DB access, no React — consumed by the ticket detail page (server) and
 * the list-row "braucht dich" marker (server).
 */

import type { LazyEvent, EventType } from "@/lib/events/types";
import {
  type Actor,
  type WorkflowState,
  transitionForEvent,
} from "@/lib/approvals/fsm";

/** Who is expected to act next. `agent` = swarm working / done. `none` = terminal. */
export type Responsible = "user" | "agent" | "none";

/** Coarse urgency for visual weight: `act` ⇒ user must do something. */
export type HandoffTone = "act" | "wait" | "done";

export interface AnswerRequiredRef {
  kind: string;
  preview: string;
  /** Deep-link target carried in the original push payload (auth-token-free). */
  url?: string;
}

export interface TicketHandoff {
  /** Who the ball is with right now. */
  responsible: Responsible;
  /** Visual weight: only `act` deserves the "braucht dich" marker. */
  tone: HandoffTone;
  /** One-line human-readable status, German (operator-facing). */
  line: string;
  /** The actor string of the last FSM transition (e.g. "agent:senior-dev"). */
  lastActor: string | null;
  /** Coarse class of the last actor for badge logic. */
  lastActorKind: Actor | "system" | null;
  /**
   * Anchor of the primary one-tap action the operator should take, or null.
   * Matches an `id` rendered by `WorkflowPipeline` so the jump lands on the
   * actual button (e.g. "#wf-approve").
   */
  actionAnchor: string | null;
  /** Short verb for the one-tap CTA (e.g. "Freigeben"), or null. */
  actionLabel: string | null;
  /** An open answer_required request that blocks the run, if any. */
  answerRequired: AnswerRequiredRef | null;
}

const FSM_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  "approval_requested",
  "approved",
  "rejected",
  "executed",
  "closed",
  "reopened",
]);

/** Coarse-classify an event actor string. */
export function classifyActor(
  actor: string | null | undefined,
): Actor | "system" | null {
  if (!actor) return null;
  if (actor === "system") return "system";
  if (actor.startsWith("agent:")) return "agent";
  if (actor.startsWith("user:")) return "user";
  return null;
}

/**
 * The last event that drove an FSM transition (newest-first scan). The event
 * list is expected oldest-first (as `getTimeline` returns it).
 */
function lastFsmEvent(events: ReadonlyArray<LazyEvent>): LazyEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (FSM_EVENT_TYPES.has(events[i].eventType)) return events[i];
  }
  return null;
}

/**
 * The most recent *open* `answer_required` request. We treat it as resolved
 * once any later FSM transition, comment, or user_feedback event follows it
 * (the operator engaged), or a newer answer_required supersedes it.
 */
function openAnswerRequired(
  events: ReadonlyArray<LazyEvent>,
): AnswerRequiredRef | null {
  let idx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].eventType === "answer_required") {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;

  // Resolved if the operator engaged after the request.
  for (let j = idx + 1; j < events.length; j++) {
    const t = events[j].eventType;
    if (
      t === "user_feedback" ||
      t === "commented" ||
      FSM_EVENT_TYPES.has(t)
    ) {
      return null;
    }
  }

  const p = events[idx].payload ?? {};
  const kind = typeof p.kind === "string" ? p.kind : "answer";
  const preview =
    typeof p.preview === "string" && p.preview.length > 0
      ? p.preview
      : "Eine Frage wartet auf deine Antwort.";
  const url = typeof p.url === "string" ? p.url : undefined;
  return { kind, preview, url };
}

/**
 * Derive the "who is up" handoff for a ticket from its FSM state and event log.
 *
 * @param state  the projected workflow state (from `ticket.workflowState`)
 * @param events the ticket timeline, oldest-first (`getTimeline`)
 */
export function deriveTicketHandoff(
  state: WorkflowState,
  events: ReadonlyArray<LazyEvent>,
): TicketHandoff {
  const fsmEvent = lastFsmEvent(events);
  const lastActor = fsmEvent?.actor ?? null;
  const lastActorKind = classifyActor(lastActor);
  // `system` and `user:*` both act with user privileges (see approvals/service
  // `asActor`), so for handoff purposes the cron (`system`) counts as the agent
  // side ONLY when it left the ticket in a state that needs a human — which the
  // state machine already encodes below. We keep the raw kind for the badge but
  // drive the line off `state` first.
  const fromAgent = lastActorKind === "agent";

  const answerRequired = openAnswerRequired(events);

  // An open answer_required always wins: it is an explicit blocking request.
  if (answerRequired) {
    return {
      responsible: "user",
      tone: "act",
      line: "Eine Frage wartet auf deine Antwort",
      lastActor,
      lastActorKind,
      actionAnchor: "#wf-answer-required",
      actionLabel: "Antworten",
      answerRequired,
    };
  }

  switch (state) {
    case "review":
      // Agents cannot approve themselves (FSM actor policy) → the ball is
      // always with the user in review. If an agent requested it, make the
      // handoff explicit; otherwise it's still a user decision.
      return {
        responsible: "user",
        tone: "act",
        line: fromAgent
          ? "Agent wartet auf deine Freigabe"
          : "Wartet auf deine Freigabe",
        lastActor,
        lastActorKind,
        actionAnchor: "#wf-approve",
        actionLabel: "Freigeben",
        answerRequired: null,
      };
    case "executed":
      // The work ran (agent or you). Result needs a human glance before close.
      return {
        responsible: "user",
        tone: "act",
        line: fromAgent
          ? "Agent hat ausgeführt — Ergebnis prüfen"
          : "Ausgeführt — Ergebnis prüfen & schließen",
        lastActor,
        lastActorKind,
        actionAnchor: "#wf-close",
        actionLabel: "Schließen",
        answerRequired: null,
      };
    case "approved":
      // Freigegeben — the agent (or the auto-advance cron) can now execute.
      return {
        responsible: "agent",
        tone: "wait",
        line: "Freigegeben — Agent kann ausführen",
        lastActor,
        lastActorKind,
        actionAnchor: null,
        actionLabel: null,
        answerRequired: null,
      };
    case "draft":
      return {
        responsible: "user",
        tone: "wait",
        line: "Entwurf — Freigabe anfordern, wenn bereit",
        lastActor,
        lastActorKind,
        actionAnchor: "#wf-request_approval",
        actionLabel: "Freigabe anfordern",
        answerRequired: null,
      };
    case "rejected":
      return {
        responsible: "user",
        tone: "wait",
        line: "Abgelehnt — wieder öffnen, um weiterzuarbeiten",
        lastActor,
        lastActorKind,
        actionAnchor: "#wf-reopen",
        actionLabel: "Wieder öffnen",
        answerRequired: null,
      };
    case "closed":
    default:
      return {
        responsible: "none",
        tone: "done",
        line: "Geschlossen — nichts zu tun",
        lastActor,
        lastActorKind,
        actionAnchor: null,
        actionLabel: null,
        answerRequired: null,
      };
  }
}

/**
 * Lightweight list-row signal: does this ticket *need the operator* right now?
 *
 * Per SP-11 §3: sparing "braucht dich" marker when state ∈ {review, executed}
 * AND the last actor is an agent. We derive the last FSM actor from the
 * event log; if no events are available we fall back to `false` (no marker).
 *
 * The list page projects tickets WITHOUT their event log, so this also accepts
 * a pre-computed `lastActorKind` to avoid an N+1 timeline fetch.
 */
export function ticketNeedsOperator(
  state: WorkflowState | undefined,
  lastActorKind: Actor | "system" | null,
): boolean {
  if (state !== "review" && state !== "executed") return false;
  return lastActorKind === "agent";
}

/**
 * Re-export of the FSM event-type guard for callers that only have the
 * projection and want to map events without importing the whole FSM.
 */
export function isFsmEvent(eventType: EventType): boolean {
  return transitionForEvent(eventType) !== null;
}
