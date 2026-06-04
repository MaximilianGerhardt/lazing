/**
 * Event-Projections — Event-Log -> Domain-State.
 *
 * All reads go through the projection. No direct queries against
 * entity tables (there are none — we only have the event log).
 *
 * Performance note: currently EVERY projection replays all relevant
 * events. OK for the MVP (n=<1000). Phase 6 introduces snapshots
 * (e.g. `ticket_snapshots` with `last_event_id`).
 */

import { and, asc, desc, eq, gt, like } from "drizzle-orm";

import { getDb } from "../../db/client";
import { events } from "../../db/schema/events";
import { transitionForEvent, nextState, DEFAULT_STATE } from "../approvals/fsm";
import type {
  ActorType,
  DecisionProjection,
  EntityType,
  LazyEvent,
  ReviewRequestData,
  SegmentId,
  Sensitivity,
  TicketProjection,
  UserFeedbackData,
} from "./types";

// ---------------------------------------------------------------------------
// Row -> LazyEvent
// ---------------------------------------------------------------------------

function rowToEvent(row: typeof events.$inferSelect): LazyEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload ?? "{}");
  } catch {
    payload = { _parseError: true, _raw: row.payload };
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    segmentId: row.segmentId as SegmentId,
    entityType: row.entityType as EntityType,
    entityId: row.entityId,
    eventType: row.eventType as LazyEvent["eventType"],
    actor: row.actor as ActorType,
    payload,
    sensitivity: row.sensitivity as Sensitivity,
    signature: row.signature ?? undefined,
    replayedFrom: row.replayedFrom ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Ticket-Projection
// ---------------------------------------------------------------------------

export async function projectTickets(segmentId?: SegmentId): Promise<TicketProjection[]> {
  const db = getDb();
  const where = segmentId
    ? and(eq(events.entityType, "ticket"), eq(events.segmentId, segmentId))
    : eq(events.entityType, "ticket");

  const rows = db
    .select()
    .from(events)
    .where(where)
    .orderBy(asc(events.createdAt))
    .all();

  const byId = new Map<string, TicketProjection>();

  for (const row of rows) {
    const ev = rowToEvent(row);
    foldTicket(byId, ev);
  }

  // Sub-ticket aggregation (Phase H): each one with a parentTicketId fills its
  // sub-tickets list at the parent. Idempotent.
  for (const t of byId.values()) {
    if (t.parentTicketId) {
      const parent = byId.get(t.parentTicketId);
      if (parent) {
        if (!parent.subTicketIds) parent.subTicketIds = [];
        if (!parent.subTicketIds.includes(t.id)) {
          parent.subTicketIds.push(t.id);
        }
      }
    }
  }

  return Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Applies an FSM transition to the ticket projection. Stores the
 * new workflow state in `workflowState`. Defensive: on an invalid
 * transition (no edge) the state stays unchanged — we do not log
 * (that would be recursive-event hell).
 */
function applyFsmTransition(t: TicketProjection, ev: LazyEvent): void {
  const trans = transitionForEvent(ev.eventType);
  if (!trans) return;
  const current =
    (t.workflowState as ReturnType<typeof nextState>) ?? DEFAULT_STATE;
  // If the stored workflowState is not a known FSM state (e.g. legacy
  // "in_review" string), start from DEFAULT_STATE so the FSM advances
  // sensibly on the next event.
  const safeCurrent = isWorkflowState(current) ? current : DEFAULT_STATE;
  const n = nextState(safeCurrent, trans);
  if (n) t.workflowState = n;
}

function isWorkflowState(
  v: unknown,
): v is "draft" | "review" | "approved" | "executed" | "closed" | "rejected" {
  return (
    v === "draft" ||
    v === "review" ||
    v === "approved" ||
    v === "executed" ||
    v === "closed" ||
    v === "rejected"
  );
}

function foldTicket(
  byId: Map<string, TicketProjection>,
  ev: LazyEvent,
): void {
  const existing = byId.get(ev.entityId);

  const ensure = (): TicketProjection => {
    if (existing) return existing;
    const seed: TicketProjection = {
      id: ev.entityId,
      segmentId: ev.segmentId,
      title: asString(ev.payload.title) ?? "(ohne Titel)",
      status: "open",
      workflowState: "draft",
      createdAt: ev.createdAt,
      updatedAt: ev.createdAt,
      tags: [],
      sessionRefs: [],
    };
    byId.set(ev.entityId, seed);
    return seed;
  };

  const collectSessionRef = (t: TicketProjection): void => {
    const sid =
      asString(ev.payload.sessionId) ?? asString(ev.payload.session_id);
    if (!sid) return;
    if (!t.sessionRefs) t.sessionRefs = [];
    if (!t.sessionRefs.includes(sid)) t.sessionRefs.push(sid);
  };

  const collectWorkstreamLink = (t: TicketProjection): void => {
    const wsid = asString(ev.payload.workstreamId);
    if (wsid) t.workstreamId = wsid;
    const parent = asString(ev.payload.parentTicketId);
    if (parent) t.parentTicketId = parent;
  };

  switch (ev.eventType) {
    case "created": {
      const t = ensure();
      const title = asString(ev.payload.title);
      if (title) t.title = title;
      const body = asString(ev.payload.body);
      if (body) t.body = body;
      const prio = asString(ev.payload.prio);
      if (prio) t.prio = prio;
      const status = asStatus(ev.payload.status);
      if (status) t.status = status;
      const workflowState = asString(ev.payload.workflowState);
      if (workflowState) t.workflowState = workflowState;
      const assignee = asString(ev.payload.assignee);
      if (assignee) t.assignee = assignee;
      const due = asString(ev.payload.due);
      if (due) t.due = due;
      const tags = asStringArray(ev.payload.tags);
      if (tags) t.tags = tags;
      t.createdAt = ev.createdAt;
      t.updatedAt = ev.createdAt;
      break;
    }
    case "updated": {
      const t = ensure();
      const title = asString(ev.payload.title);
      if (title) t.title = title;
      const body = asString(ev.payload.body);
      if (body !== undefined) t.body = body;
      const prio = asString(ev.payload.prio);
      if (prio) t.prio = prio;
      const workflowState = asString(ev.payload.workflowState);
      if (workflowState !== undefined) t.workflowState = workflowState;
      const assignee = asString(ev.payload.assignee);
      if (assignee) t.assignee = assignee;
      const due = asString(ev.payload.due);
      if (due) t.due = due;
      const tags = asStringArray(ev.payload.tags);
      if (tags) t.tags = tags;
      t.updatedAt = ev.createdAt;
      break;
    }
    case "status_changed": {
      const t = ensure();
      const status = asStatus(ev.payload.status);
      if (status) t.status = status;
      t.updatedAt = ev.createdAt;
      break;
    }
    case "review_request": {
      const t = ensure();
      const data = ev.payload as Partial<ReviewRequestData>;
      t.reviewRequest = {
        checklist: Array.isArray(data.checklist) ? data.checklist : [],
        testTargetUrl: data.testTargetUrl,
        testTargetLabel: data.testTargetLabel,
        description: data.description,
      };
      t.updatedAt = ev.createdAt;
      break;
    }
    case "user_feedback": {
      const t = ensure();
      const fb: UserFeedbackData = {
        quickAction: ev.payload.quickAction as UserFeedbackData["quickAction"],
        text: asString(ev.payload.text),
        checkedItems: asStringArray(ev.payload.checkedItems),
        submittedAt: ev.createdAt,
      };
      t.feedback = [...(t.feedback ?? []), fb];
      t.updatedAt = ev.createdAt;
      break;
    }
    case "closed": {
      const t = ensure();
      t.status = "done";
      t.closedAt = ev.createdAt;
      t.updatedAt = ev.createdAt;
      // Also advance FSM (executed → closed, etc.)
      applyFsmTransition(t, ev);
      break;
    }
    case "reopened": {
      const t = ensure();
      t.status = "open";
      t.closedAt = undefined;
      t.updatedAt = ev.createdAt;
      applyFsmTransition(t, ev);
      break;
    }
    case "approval_requested":
    case "approved":
    case "rejected":
    case "executed": {
      const t = ensure();
      applyFsmTransition(t, ev);
      t.updatedAt = ev.createdAt;
      break;
    }
    default: {
      const t = ensure();
      t.updatedAt = ev.createdAt;
    }
  }

  // After each event, try to grab a session reference from payload.sessionId
  // — regardless of the event type. This enables cross-session tracking
  // as soon as lazyos-cli or the agent CLI includes the sessionId in the payload.
  const current = byId.get(ev.entityId);
  if (current) {
    collectSessionRef(current);
    collectWorkstreamLink(current);
  }
}

/**
 * Single-ticket projection — replays ONLY events for this one entityId.
 * Significantly more efficient than projectTickets + find when you only need
 * one ticket (detail page, API GET).
 */
/** ULID format (Crockford-Base32, 26 chars), optional 4-char prefix like "TCK-". */
// Accepts classic ULIDs (26 chars Crockford) AND sub-ticket IDs from
// Phase IT (createSubTicketEvent) that were generated with base36 — those also
// contain I/L/O/U. Defense-in-depth: still no wildcards (% _) in the match.
const ID_LIKE_RE = /^([A-Z]{2,5}-)?[A-Z0-9]{8,32}$/i;

export async function projectTicket(
  id: string,
): Promise<TicketProjection | null> {
  // Defense-in-depth: user input must not carry LIKE wildcards (% _).
  // Drizzle does parametrize, but an invalid id value would produce a
  // broad match below in the LIKE.
  if (!ID_LIKE_RE.test(id)) return null;

  const db = getDb();
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.entityType, "ticket"), eq(events.entityId, id)))
    .orderBy(asc(events.createdAt))
    .all();

  if (rows.length === 0) return null;

  const byId = new Map<string, TicketProjection>();
  for (const row of rows) {
    foldTicket(byId, rowToEvent(row));
  }
  const ticket = byId.get(id) ?? null;
  if (!ticket) return null;

  // Sub-ticket aggregation: the master ticket does not know its subs from
  // its own events — subs live as their own entityIds. We search all
  // ticket events whose payload carries parentTicketId == id.
  // JSON LIKE on payload is robust because emitEvent always serializes via
  // JSON.stringify with consistent key order.
  // KNOWN-ISSUE: on re-parenting (parentTicketId is re-pointed via an "updated"
  // event) the sub appears here in BOTH masters. projectTickets()
  // by contrast reads only the newest value. Tracking: P3 ticket "re-parenting
  // consistency" (see backlog).
  const subRows = db
    .select({ entityId: events.entityId })
    .from(events)
    .where(
      and(
        eq(events.entityType, "ticket"),
        like(events.payload, `%"parentTicketId":"${id}"%`),
      ),
    )
    .all();
  if (subRows.length > 0) {
    const subIds = Array.from(new Set(subRows.map((r) => r.entityId)));
    ticket.subTicketIds = subIds;
  }
  return ticket;
}

/**
 * Timeline for a single ticket — all events chronologically (oldest→newest).
 * No projection logic, pure event log.
 */
export async function getTicketTimeline(id: string): Promise<LazyEvent[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(events)
    .where(and(eq(events.entityType, "ticket"), eq(events.entityId, id)))
    .orderBy(asc(events.createdAt))
    .all();
  return rows.map(rowToEvent);
}

// ---------------------------------------------------------------------------
// Decision-Projection
// ---------------------------------------------------------------------------

export async function projectDecisions(
  segmentId?: SegmentId,
  limit = 50,
): Promise<DecisionProjection[]> {
  const db = getDb();
  const where = segmentId
    ? and(eq(events.entityType, "decision"), eq(events.segmentId, segmentId))
    : eq(events.entityType, "decision");

  const rows = db
    .select()
    .from(events)
    .where(where)
    .orderBy(asc(events.createdAt))
    .all();

  const byId = new Map<string, DecisionProjection>();

  for (const row of rows) {
    const ev = rowToEvent(row);
    foldDecision(byId, ev);
  }

  return Array.from(byId.values())
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .slice(0, limit);
}

function foldDecision(
  byId: Map<string, DecisionProjection>,
  ev: LazyEvent,
): void {
  const existing = byId.get(ev.entityId);
  const payload = ev.payload as Record<string, unknown>;

  const ensure = (): DecisionProjection => {
    if (existing) return existing;
    const seed: DecisionProjection = {
      id: ev.entityId,
      segmentId: ev.segmentId,
      headline: asString(payload.headline) ?? "(ohne Titel)",
      sub: asString(payload.sub),
      options: [],
      createdAt: ev.createdAt,
    };
    byId.set(ev.entityId, seed);
    return seed;
  };

  switch (ev.eventType) {
    case "created": {
      const d = ensure();
      const headline = asString(payload.headline);
      if (headline) d.headline = headline;
      const sub = asString(payload.sub);
      if (sub !== undefined) d.sub = sub;
      if (Array.isArray(payload.options)) {
        d.options = payload.options as DecisionProjection["options"];
      }
      d.createdAt = ev.createdAt;
      break;
    }
    case "updated": {
      const d = ensure();
      const headline = asString(payload.headline);
      if (headline) d.headline = headline;
      if (Array.isArray(payload.options)) {
        d.options = payload.options as DecisionProjection["options"];
      }
      break;
    }
    case "decision_made": {
      const d = ensure();
      const chosen = asString(payload.chosenOptionId);
      if (chosen) d.chosenOptionId = chosen;
      d.decidedAt = ev.createdAt;
      d.decidedBy = ev.actor;
      break;
    }
    case "decision_reverted": {
      const d = ensure();
      d.chosenOptionId = undefined;
      d.decidedAt = undefined;
      d.decidedBy = undefined;
      break;
    }
    default:
      // Other event types don't mutate decision state.
      ensure();
  }
}

// ---------------------------------------------------------------------------
// Generic event-stream (for SSE initial + REST fetch)
// ---------------------------------------------------------------------------

export async function getEventStream(
  segmentId?: SegmentId,
  sinceId?: string,
  limit = 50,
): Promise<LazyEvent[]> {
  const db = getDb();

  const clauses = [];
  if (segmentId) clauses.push(eq(events.segmentId, segmentId));
  if (sinceId) clauses.push(gt(events.id, sinceId));
  const where = clauses.length === 0 ? undefined : clauses.length === 1 ? clauses[0] : and(...clauses);

  const rows = db
    .select()
    .from(events)
    .where(where)
    .orderBy(desc(events.createdAt))
    .limit(limit)
    .all();

  // Chat clear point (2026-06-02): the live-stream replay-on-connect must
  // NOT replay already-cleared chat bubbles — otherwise the history hidden
  // via `/api/chat/history/[ws]/clear` comes back over the event stream
  // (the observed "clear-history-has-no-effect" effect). The client
  // subscribes to the stream WITHOUT a segment (global replay), so we check every
  // `chat_message` sent/completed event against the clear point of ITS OWN
  // segment (not the calling segment). A map over all clear markers is
  // cheap (markers are rare). Other event types + post-clear events stay
  // untouched. Append-only, best-effort.
  let filtered = rows;
  try {
    const clearMarkers = db
      .select({ segmentId: events.segmentId, createdAt: events.createdAt })
      .from(events)
      .where(eq(events.eventType, "chat_history_cleared"))
      .all();
    if (clearMarkers.length > 0) {
      const clearBySegment = new Map<string, number>();
      for (const m of clearMarkers) {
        const prev = clearBySegment.get(m.segmentId);
        if (prev === undefined || m.createdAt > prev) {
          clearBySegment.set(m.segmentId, m.createdAt);
        }
      }
      filtered = rows.filter((r) => {
        const isChatBubble =
          r.entityType === "chat_message" &&
          (r.eventType === "chat_message_sent" ||
            r.eventType === "chat_message_completed");
        if (!isChatBubble) return true;
        const cp = clearBySegment.get(r.segmentId);
        return cp === undefined || r.createdAt > cp;
      });
    }
  } catch {
    /* non-fatal — no cutoff */
  }

  // return chronological (oldest first) so the client can append.
  return filtered.map(rowToEvent).reverse();
}

// ---------------------------------------------------------------------------
// Segment-Counts (fuer Health/UI-Header)
// ---------------------------------------------------------------------------

export async function getSegmentCounts(): Promise<
  Record<SegmentId, { total: number; open: number }>
> {
  const tickets = await projectTickets();
  const base: Record<SegmentId, { total: number; open: number }> = {};
  for (const t of tickets) {
    const bucket =
      base[t.segmentId] ?? (base[t.segmentId] = { total: 0, open: 0 });
    bucket.total += 1;
    if (t.status !== "done") bucket.open += 1;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function asStatus(v: unknown): TicketProjection["status"] | undefined {
  if (v === "open" || v === "done" || v === "danger" || v === "wait") return v;
  return undefined;
}
