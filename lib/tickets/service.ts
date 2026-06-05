/**
 * Ticket service — event-sourced CRUD facade.
 *
 * All write operations go through `emitEvent` (append-only), all reads
 * through the projections from `lib/events/project.ts`. No direct DB access.
 *
 * The API routes (`/api/tickets/*`) delegate exclusively here, so that
 * the same logic can also be used by server components (e.g. the `/tickets/[id]`
 * detail page) without an HTTP roundtrip.
 *
 * Ticket IDs: ULID with a `TCK-` prefix, so they look consistent with the
 * seed ("TCK-DEMO-001") in the UI. Base32 ULIDs still sort lexicogra-
 * phically correctly, the prefix is purely cosmetic.
 */

import { emitEvent } from "../events/emit";
import {
  getTicketTimeline,
  projectTicket,
  projectTickets,
} from "../events/project";
import type {
  ActorType,
  LazyEvent,
  TicketProjection,
  TicketStatus,
  WorkspaceId,
} from "../events/types";
import { ulid } from "../ulid";

// ---------------------------------------------------------------------------
// Input shapes — validated by the API routes via Zod, here only structured.
// ---------------------------------------------------------------------------

export interface CreateTicketInput {
  workspaceId: WorkspaceId;
  title: string;
  body?: string;
  prio?: string;
  due?: string;
  tags?: string[];
  assignee?: string;
  status?: TicketStatus;
  workflowState?: string;
  /** Overrides the default actor (`user:max`). */
  actor?: ActorType;
  /** Claude session UUID (handoff point 5) — lands as payload.sessionId. */
  sessionId?: string;
  /** Workstream container (Phase W). */
  workstreamId?: string;
  /** Parent ticket (Phase H). */
  parentTicketId?: string;
}

export interface UpdateTicketInput {
  title?: string;
  body?: string;
  prio?: string;
  due?: string;
  tags?: string[];
  assignee?: string;
  status?: TicketStatus;
  workflowState?: string;
  /** Overrides the default actor (`user:max`). */
  actor?: ActorType;
  /** Claude session UUID (handoff point 5) — lands as payload.sessionId. */
  sessionId?: string;
  /** Workstream container (Phase W). */
  workstreamId?: string;
  /** Parent ticket (Phase H). */
  parentTicketId?: string;
}

export interface ListTicketsInput {
  workspaceId?: WorkspaceId;
  /**
   * Phase IA.5 — org filter. If set, only tickets from
   * workspaces of this org are returned.
   */
  orgId?: string;
  status?: TicketStatus | "all";
  limit?: number;
  offset?: number;
  /** Full-text search over title + body. */
  query?: string;
}

export interface CommentInput {
  text: string;
  actor?: ActorType;
  /**
   * SP-11 — lightweight comment classification carried in the existing
   * `commented` event payload (free JSON, NO new event type). Lets the
   * thread render an "Anweisung"/"Frage" affordance instead of a flat comment.
   */
  intent?: "note" | "instruction" | "question";
  /** Optional handoff target (e.g. "agent:senior-dev", "max"). */
  target?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Phase ORG (2026-04-27): default is `system`, NO longer `user:max`.
// The API route caller MUST explicitly set `actor: currentActor(req)` if
// the action should be user-attributed, otherwise it lands as a system
// action in the audit log (more GDPR-compliant than a hardcoded fake user).
const DEFAULT_ACTOR: ActorType = "system";

/**
 * Creates a new ticket ID in the format `TCK-<ULID>`. The prefix is
 * cosmetic; the ULID part stays sortable.
 */
export function newTicketId(now: number = Date.now()): string {
  return `TCK-${ulid(now)}`;
}

/**
 * Uses the `workspaceId` parameter as `segmentId` in the event schema.
 * The event log still stores under the field name `segmentId`
 * (see the comment in `lib/events/types.ts`).
 */
function asSegment(workspaceId: WorkspaceId): WorkspaceId {
  return workspaceId;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createTicket(
  input: CreateTicketInput,
): Promise<TicketProjection> {
  const id = newTicketId();
  const actor = input.actor ?? DEFAULT_ACTOR;

  // Clean payload — only pass through defined fields, so the projection
  // doesn't unnecessarily process "undefined" overrides.
  const payload: Record<string, unknown> = {
    title: input.title,
  };
  if (input.body !== undefined) payload.body = input.body;
  if (input.prio !== undefined) payload.prio = input.prio;
  if (input.due !== undefined) payload.due = input.due;
  if (input.tags !== undefined) payload.tags = input.tags;
  if (input.assignee !== undefined) payload.assignee = input.assignee;
  if (input.status !== undefined) payload.status = input.status;
  if (input.workflowState !== undefined) payload.workflowState = input.workflowState;
  if (input.sessionId !== undefined) payload.sessionId = input.sessionId;
  if (input.workstreamId !== undefined) payload.workstreamId = input.workstreamId;
  if (input.parentTicketId !== undefined) payload.parentTicketId = input.parentTicketId;

  await emitEvent({
    segmentId: asSegment(input.workspaceId),
    entityType: "ticket",
    entityId: id,
    eventType: "created",
    actor,
    payload,
    sensitivity: "low",
  });

  const projection = await projectTicket(id);
  if (!projection) {
    // Should not happen — emitEvent is a sync DB insert. Defensive.
    throw new Error(`createTicket: projection missing for ${id}`);
  }
  return projection;
}

// ---------------------------------------------------------------------------
// Update — emits `updated` and/or `status_changed` depending on the patch.
// ---------------------------------------------------------------------------

export async function updateTicket(
  id: string,
  patch: UpdateTicketInput,
): Promise<TicketProjection> {
  const current = await projectTicket(id);
  if (!current) {
    throw new TicketNotFoundError(id);
  }

  const actor = patch.actor ?? DEFAULT_ACTOR;
  const segment = current.segmentId;

  // Status changes get their own, semantically clean event,
  // so timelines show "status_changed" as a first-class signal.
  if (patch.status && patch.status !== current.status) {
    await emitEvent({
      segmentId: segment,
      entityType: "ticket",
      entityId: id,
      eventType: "status_changed",
      actor,
      payload: {
        status: patch.status,
        previousStatus: current.status,
      },
      sensitivity: "low",
    });
  }

  // Everything else (incl. workflowState, assignee, title, body, prio, due, tags)
  // lands in a single collected `updated` event. If the patch was only a
  // status change, we write NO additional empty `updated`.
  const updatePayload: Record<string, unknown> = {};
  if (patch.title !== undefined && patch.title !== current.title) {
    updatePayload.title = patch.title;
  }
  if (patch.body !== undefined && patch.body !== current.body) {
    updatePayload.body = patch.body;
  }
  if (patch.prio !== undefined && patch.prio !== current.prio) {
    updatePayload.prio = patch.prio;
  }
  if (patch.due !== undefined && patch.due !== current.due) {
    updatePayload.due = patch.due;
  }
  if (patch.tags !== undefined) {
    updatePayload.tags = patch.tags;
  }
  if (patch.assignee !== undefined && patch.assignee !== current.assignee) {
    updatePayload.assignee = patch.assignee;
  }
  if (
    patch.workflowState !== undefined &&
    patch.workflowState !== current.workflowState
  ) {
    updatePayload.workflowState = patch.workflowState;
  }

  if (patch.sessionId !== undefined) {
    updatePayload.sessionId = patch.sessionId;
  }
  if (patch.workstreamId !== undefined) {
    updatePayload.workstreamId = patch.workstreamId;
  }
  if (patch.parentTicketId !== undefined) {
    updatePayload.parentTicketId = patch.parentTicketId;
  }

  if (Object.keys(updatePayload).length > 0) {
    await emitEvent({
      segmentId: segment,
      entityType: "ticket",
      entityId: id,
      eventType: "updated",
      actor,
      payload: updatePayload,
      sensitivity: "low",
    });
  }

  const next = await projectTicket(id);
  if (!next) throw new TicketNotFoundError(id);
  return next;
}

// ---------------------------------------------------------------------------
// Close (soft-delete = emit `closed`)
// ---------------------------------------------------------------------------

export async function closeTicket(
  id: string,
  actor: ActorType = DEFAULT_ACTOR,
): Promise<TicketProjection> {
  const current = await projectTicket(id);
  if (!current) throw new TicketNotFoundError(id);
  if (current.status === "done") {
    // Already closed — idempotent, no further event.
    return current;
  }

  await emitEvent({
    segmentId: current.segmentId,
    entityType: "ticket",
    entityId: id,
    eventType: "closed",
    actor,
    payload: {},
    sensitivity: "low",
  });

  const next = await projectTicket(id);
  if (!next) throw new TicketNotFoundError(id);
  return next;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getTicket(id: string): Promise<TicketProjection | null> {
  return projectTicket(id);
}

export async function listTickets(
  opts: ListTicketsInput = {},
): Promise<TicketProjection[]> {
  const all = await projectTickets(opts.workspaceId);

  let filtered = all;
  if (opts.orgId) {
    // Phase IA.5 — org scope. Only tickets from workspaces of this org.
    const { getDb } = await import("@/db/client");
    const db = getDb();
    const wsRows = db.$raw
      .prepare(
        `SELECT id FROM workspaces WHERE organization_id = ? AND archived = 0`,
      )
      .all(opts.orgId) as Array<{ id: string }>;
    const wsSet = new Set(wsRows.map((r) => r.id));
    filtered = filtered.filter((t) => {
      const wid = (t as unknown as { workspaceId?: string }).workspaceId;
      return wid ? wsSet.has(wid) : false;
    });
  }
  if (opts.status && opts.status !== "all") {
    filtered = filtered.filter((t) => t.status === opts.status);
  }
  if (opts.query) {
    const q = opts.query.trim().toLowerCase();
    if (q.length > 0) {
      filtered = filtered.filter((t) => {
        return (
          t.title.toLowerCase().includes(q) ||
          (t.body?.toLowerCase().includes(q) ?? false) ||
          t.id.toLowerCase().includes(q)
        );
      });
    }
  }

  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50));
  return filtered.slice(offset, offset + limit);
}

export async function getTimeline(id: string): Promise<LazyEvent[]> {
  const exists = await projectTicket(id);
  if (!exists) throw new TicketNotFoundError(id);
  return getTicketTimeline(id);
}

/**
 * Coarse actor kind that performed an FSM transition.
 * Mirrors the handoff classification (`lib/tickets/handoff.classifyActor`).
 */
export type LastFsmActorKind = "user" | "agent" | "system";

/**
 * Returns, per ticket ID, the coarse actor kind of the LAST FSM transition
 * (approval_requested / approved / rejected / executed / closed / reopened).
 *
 * Why: the list view (`/tickets`) needs a sparing "braucht dich" marker when a
 * ticket is in review/executed AND an *agent* left it there — but the ticket
 * projection does not carry the last actor, and fetching each ticket's full
 * timeline would be an N+1. This does it in a single query over the FSM events,
 * folding newest-actor-per-entity. No new schema, no projection change.
 *
 * Scoped to one workspace when `workspaceId` is given (matches the list filter).
 */
export async function getLastFsmActorByTicket(
  workspaceId?: WorkspaceId,
): Promise<Map<string, LastFsmActorKind>> {
  const { getDb } = await import("@/db/client");
  const { events } = await import("@/db/schema/events");
  const { and, asc, eq, inArray } = await import("drizzle-orm");

  const FSM_TYPES = [
    "approval_requested",
    "approved",
    "rejected",
    "executed",
    "closed",
    "reopened",
  ] as const;

  const db = getDb();
  const base = and(
    eq(events.entityType, "ticket"),
    inArray(events.eventType, FSM_TYPES as unknown as string[]),
  );
  const where = workspaceId
    ? and(base, eq(events.segmentId, workspaceId))
    : base;

  const rows = db
    .select({
      entityId: events.entityId,
      actor: events.actor,
    })
    .from(events)
    .where(where)
    .orderBy(asc(events.createdAt))
    .all();

  const out = new Map<string, LastFsmActorKind>();
  for (const row of rows) {
    const actor = row.actor;
    const kind: LastFsmActorKind | null =
      actor === "system"
        ? "system"
        : actor.startsWith("agent:")
          ? "agent"
          : actor.startsWith("user:")
            ? "user"
            : null;
    if (kind) out.set(row.entityId, kind); // ascending ⇒ last write wins
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comment
// ---------------------------------------------------------------------------

export async function addComment(
  id: string,
  input: CommentInput,
): Promise<LazyEvent> {
  const current = await projectTicket(id);
  if (!current) throw new TicketNotFoundError(id);

  const text = input.text.trim();
  if (text.length === 0) {
    throw new Error("comment text must not be empty");
  }

  const payload: Record<string, unknown> = { text };
  // intent/target ride in the existing `commented` payload (free JSON) — N8:
  // the thread stays evidence, not a new event type.
  if (input.intent && input.intent !== "note") payload.intent = input.intent;
  if (input.target) payload.target = input.target;

  return emitEvent({
    segmentId: current.segmentId,
    entityType: "ticket",
    entityId: id,
    eventType: "commented",
    actor: input.actor ?? DEFAULT_ACTOR,
    payload,
    sensitivity: "low",
  });
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TicketNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`ticket ${id} not found`);
    this.name = "TicketNotFoundError";
  }
}

// Re-export for convenience so API routes and pages only import one module.
export { projectTicket, projectTickets, getTicketTimeline };
