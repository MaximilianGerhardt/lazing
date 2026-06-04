/**
 * Work-Products service (sprint 2 · section 7I).
 *
 * Writes go through this service so that (a) ticket existence is checked
 * and (b) a `work_product_attached` event is emitted.
 *
 * Reads, by contrast, are direct SQL selects — work products are
 * not a projection of the event log but a table of their own.
 * (Unlike tickets: the event is just a signal, the state lives
 * in `work_products`.)
 *
 * Soft delete: status='superseded' instead of DELETE.
 */

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { workProducts } from "../../db/schema/work_products";
import { emitEvent } from "../events/emit";
import type { ActorType } from "../events/types";
import { projectTicket } from "../events/project";
import { autoAdvanceOnWorkProductFinal } from "../tickets/auto-advance";
import type {
  WorkProduct,
  WorkProductStatus,
  WorkProductType,
} from "./schema";

// ---------------------------------------------------------------------------
// ID helper — WP-<nanoid(10)> in the Crockford base32 alphabet (no external
// nanoid dependency; ulid.ts already provides the alphabet indirectly).
// ---------------------------------------------------------------------------

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_LEN = 10;

function randomId(): string {
  const buf = new Uint8Array(ID_LEN);
  globalThis.crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < ID_LEN; i++) {
    out += ID_ALPHABET[buf[i]! % ID_ALPHABET.length];
  }
  return out;
}

export function newWorkProductId(): string {
  return `WP-${randomId()}`;
}

// ---------------------------------------------------------------------------
// Row <-> Domain
// ---------------------------------------------------------------------------

function rowToWorkProduct(
  row: typeof workProducts.$inferSelect,
): WorkProduct {
  return {
    id: row.id,
    ticketId: row.ticketId,
    type: row.type as WorkProductType,
    title: row.title,
    content: row.content,
    mime: row.mime ?? null,
    bytes: row.bytes,
    status: row.status as WorkProductStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WorkProductNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`work_product ${id} not found`);
    this.name = "WorkProductNotFoundError";
  }
}

export class WorkProductTicketMismatchError extends Error {
  constructor(
    public readonly wpId: string,
    public readonly expectedTicket: string,
    public readonly actualTicket: string,
  ) {
    super(
      `work_product ${wpId} belongs to ${actualTicket}, not ${expectedTicket}`,
    );
    this.name = "WorkProductTicketMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Input-Shapes
// ---------------------------------------------------------------------------

export interface CreateWorkProductInput {
  ticketId: string;
  type: WorkProductType;
  title: string;
  content: string;
  mime?: string;
  status?: WorkProductStatus;
  /** Who is creating it? Default 'user' (no actor prefix; not to be confused
   *  with the LazyEvent actor — there it MUST be 'user:*' / 'agent:*' / 'system'). */
  createdBy?: string;
}

export interface UpdateWorkProductInput {
  title?: string;
  content?: string;
  mime?: string;
  status?: WorkProductStatus;
  /** Actor for the `updated` event. */
  actor?: ActorType;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listWorkProducts(
  ticketId: string,
  opts: { includeSuperseded?: boolean } = {},
): Promise<WorkProduct[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(workProducts)
    .where(eq(workProducts.ticketId, ticketId))
    .orderBy(desc(workProducts.createdAt))
    .all();

  const filtered = opts.includeSuperseded
    ? rows
    : rows.filter((r) => r.status !== "superseded");
  return filtered.map(rowToWorkProduct);
}

export async function getWorkProduct(
  ticketId: string,
  wpId: string,
): Promise<WorkProduct | null> {
  const db = getDb();
  const row = db
    .select()
    .from(workProducts)
    .where(
      and(eq(workProducts.id, wpId), eq(workProducts.ticketId, ticketId)),
    )
    .get();
  if (!row) return null;
  return rowToWorkProduct(row);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createWorkProduct(
  input: CreateWorkProductInput,
): Promise<WorkProduct> {
  // 1. Ticket must exist — derive a clean 404 from the API.
  const ticket = await projectTicket(input.ticketId);
  if (!ticket) {
    throw new WorkProductNotFoundError(input.ticketId);
  }

  const db = getDb();
  const now = Date.now();
  const id = newWorkProductId();
  const status: WorkProductStatus = input.status ?? "draft";
  const createdBy = input.createdBy ?? "user";
  const bytes = Buffer.byteLength(input.content, "utf8");

  db
    .insert(workProducts)
    .values({
      id,
      ticketId: input.ticketId,
      type: input.type,
      title: input.title,
      content: input.content,
      mime: input.mime ?? null,
      bytes,
      status,
      createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // 2. Emit event — projects cleanly into the timeline.
  //    The event actor must conform to the LazyEvent actor contract.
  const eventActor: ActorType = normalizeActor(createdBy);
  await emitEvent({
    segmentId: ticket.segmentId,
    entityType: "ticket",
    entityId: input.ticketId,
    eventType: "work_product_attached",
    actor: eventActor,
    payload: {
      workProductId: id,
      type: input.type,
      title: input.title,
      status,
      bytes,
    },
    sensitivity: "low",
  });

  // Auto-advance: when the work product is attached directly as "final",
  // we close the ticket (handoff point 3).
  if (status === "final") {
    await autoAdvanceOnWorkProductFinal(input.ticketId).catch(() => undefined);
  }

  const row = db
    .select()
    .from(workProducts)
    .where(eq(workProducts.id, id))
    .get();
  if (!row) {
    throw new Error(`createWorkProduct: row missing for ${id}`);
  }
  return rowToWorkProduct(row);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateWorkProduct(
  ticketId: string,
  wpId: string,
  patch: UpdateWorkProductInput,
): Promise<WorkProduct> {
  const current = await getWorkProduct(ticketId, wpId);
  if (!current) throw new WorkProductNotFoundError(wpId);

  const db = getDb();
  const now = Date.now();
  const nextContent = patch.content ?? current.content;
  const nextBytes =
    patch.content !== undefined
      ? Buffer.byteLength(nextContent, "utf8")
      : current.bytes;

  db
    .update(workProducts)
    .set({
      title: patch.title ?? current.title,
      content: nextContent,
      mime: patch.mime ?? current.mime ?? null,
      bytes: nextBytes,
      status: patch.status ?? current.status,
      updatedAt: now,
    })
    .where(eq(workProducts.id, wpId))
    .run();

  // Status transitions get their own event for the timeline.
  // Phase ORG (2026-04-27): default `system` instead of a `user:max` fake.
  const actor: ActorType = patch.actor ?? "system";
  if (patch.status && patch.status !== current.status) {
    await emitEvent({
      segmentId: (await projectTicket(ticketId))?.segmentId ?? "lazyos",
      entityType: "ticket",
      entityId: ticketId,
      eventType:
        patch.status === "superseded"
          ? "work_product_superseded"
          : "work_product_status_changed",
      actor,
      payload: {
        workProductId: wpId,
        previousStatus: current.status,
        status: patch.status,
      },
      sensitivity: "low",
    });

    // Auto-advance: work product set to final → close the ticket
    // (handoff point 3).
    if (patch.status === "final" && current.status !== "final") {
      await autoAdvanceOnWorkProductFinal(ticketId).catch(() => undefined);
    }
  }

  const row = db
    .select()
    .from(workProducts)
    .where(eq(workProducts.id, wpId))
    .get();
  if (!row) throw new WorkProductNotFoundError(wpId);
  return rowToWorkProduct(row);
}

// ---------------------------------------------------------------------------
// Soft-Delete (status -> 'superseded')
// ---------------------------------------------------------------------------

export async function supersedeWorkProduct(
  ticketId: string,
  wpId: string,
  actor: ActorType = "system",
): Promise<WorkProduct> {
  return updateWorkProduct(ticketId, wpId, {
    status: "superseded",
    actor,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeActor(createdBy: string): ActorType {
  if (createdBy === "system") return "system";
  if (
    createdBy.startsWith("user:") ||
    createdBy.startsWith("agent:")
  ) {
    return createdBy as ActorType;
  }
  // Phase ORG: a bare `user` marker (legacy data) no longer gets an
  // invented user name. System is semantically correct for
  // unattributed legacy input.
  if (createdBy === "user") return "system";
  // Fallback: safe prefix.
  return `user:${createdBy}` as ActorType;
}
