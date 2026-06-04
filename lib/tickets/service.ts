/**
 * Ticket-Service — Event-Sourced CRUD-Facade.
 *
 * Alle Write-Operationen gehen durch `emitEvent` (append-only), alle Reads
 * durch die Projections aus `lib/events/project.ts`. Kein direkter DB-Zugriff.
 *
 * Die API-Routes (`/api/tickets/*`) delegieren ausschliesslich hierher, damit
 * die gleiche Logik auch von Server Components (z.B. `/tickets/[id]` Detail-
 * Seite) ohne HTTP-Roundtrip genutzt werden kann.
 *
 * Ticket-IDs: ULID mit `TCK-` Praefix, damit sie in der UI konsistent zum
 * Seed ("TCK-DEMO-001") aussehen. Base32-ULIDs sortieren weiterhin lexikogra-
 * phisch korrekt, der Praefix ist rein kosmetisch.
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
// Input-Shapes — von den API-Routes via Zod validiert, hier nur strukturiert.
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
  /** Ueberschreibt den Default-Actor (`user:max`). */
  actor?: ActorType;
  /** Claude-Session-UUID (Handoff-Punkt 5) — landet als payload.sessionId. */
  sessionId?: string;
  /** Workstream-Container (Phase W). */
  workstreamId?: string;
  /** Parent-Ticket (Phase H). */
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
  /** Ueberschreibt den Default-Actor (`user:max`). */
  actor?: ActorType;
  /** Claude-Session-UUID (Handoff-Punkt 5) — landet als payload.sessionId. */
  sessionId?: string;
  /** Workstream-Container (Phase W). */
  workstreamId?: string;
  /** Parent-Ticket (Phase H). */
  parentTicketId?: string;
}

export interface ListTicketsInput {
  workspaceId?: WorkspaceId;
  /**
   * Phase IA.5 — Org-Filter. Wenn gesetzt, werden nur Tickets aus
   * Workspaces dieser Org zurückgegeben.
   */
  orgId?: string;
  status?: TicketStatus | "all";
  limit?: number;
  offset?: number;
  /** Volltext-Suche ueber title + body. */
  query?: string;
}

export interface CommentInput {
  text: string;
  actor?: ActorType;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Phase ORG (2026-04-27): Default ist `system`, NICHT mehr `user:max`.
// API-Route-Caller MUSS explizit `actor: currentActor(req)` setzen wenn
// die Action User-attribuiert sein soll, sonst landet sie als System-
// Action im Audit-Log (DSGVO-konformer als hardcoded fake-User).
const DEFAULT_ACTOR: ActorType = "system";

/**
 * Erzeugt eine neue Ticket-ID im Format `TCK-<ULID>`. Der Prefix ist
 * kosmetisch; der ULID-Teil bleibt sortierbar.
 */
export function newTicketId(now: number = Date.now()): string {
  return `TCK-${ulid(now)}`;
}

/**
 * Nutzt den `workspaceId`-Parameter als `segmentId` im Event-Schema.
 * Der Event-Log speichert weiterhin unter dem Feld-Namen `segmentId`
 * (siehe `lib/events/types.ts` Kommentar).
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

  // Clean payload — nur definierte Felder weiterreichen, damit projection
  // nicht unnoetig "undefined"-Overrides verarbeitet.
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
    // Sollte nicht passieren — emitEvent ist sync DB-Insert. Defensive.
    throw new Error(`createTicket: projection missing for ${id}`);
  }
  return projection;
}

// ---------------------------------------------------------------------------
// Update — emittiert je nach Patch `updated` und/oder `status_changed`.
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

  // Status-Changes bekommen ein eigenes, semantisch reines Event,
  // damit Timelines "status_changed" als first-class Signal anzeigen.
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

  // Alles andere (inkl. workflowState, assignee, title, body, prio, due, tags)
  // landet in einem gesammelten `updated`-Event. Wenn der Patch nur ein
  // Status-Change war, schreiben wir KEIN zusaetzliches leeres `updated`.
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
    // Bereits geschlossen — idempotent, kein weiteres Event.
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
    // Phase IA.5 — Org-Scope. Nur Tickets aus Workspaces dieser Org.
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

  return emitEvent({
    segmentId: current.segmentId,
    entityType: "ticket",
    entityId: id,
    eventType: "commented",
    actor: input.actor ?? DEFAULT_ACTOR,
    payload: { text },
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
