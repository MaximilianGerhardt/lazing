/**
 * Work-Products Service (Sprint 2 · Section 7I).
 *
 * Writes gehen durch diesen Service, damit (a) Ticket-Existenz geprueft
 * wird und (b) ein `work_product_attached` Event emittiert wird.
 *
 * Lesezugriffe sind dagegen direkter SQL-Select — Work-Products sind
 * keine Projektion aus dem Event-Log, sondern eine eigene Tabelle.
 * (Anders als Tickets: das Event ist nur ein Signal, der State lebt
 * in `work_products`.)
 *
 * Soft-Delete: Status='superseded' statt DELETE.
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
// ID-Helfer — WP-<nanoid(10)> in Crockford-Base32-Alphabet (keine externe
// nanoid-Dependency; ulid.ts liefert das Alphabet bereits indirekt).
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
  /** Wer legt an? Default 'user' (kein Actor-Prefix, nicht verwechseln
   *  mit LazyEvent-Actor — dort MUSS es 'user:*' / 'agent:*' / 'system'
   *  sein). */
  createdBy?: string;
}

export interface UpdateWorkProductInput {
  title?: string;
  content?: string;
  mime?: string;
  status?: WorkProductStatus;
  /** Actor fuer das `updated`-Event. */
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
  // 1. Ticket muss existieren — saubere 404 aus API herleiten.
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

  // 2. Event emittieren — projeziert sauber in die Timeline.
  //    Event-Actor muss dem LazyEvent-Actor-Contract entsprechen.
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

  // Auto-Advance: Wenn das Work-Product direkt als "final" angehängt wird,
  // schliessen wir das Ticket (Handoff-Punkt 3).
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

  // Status-Uebergaenge kriegen ein eigenes Event fuer die Timeline.
  // Phase ORG (2026-04-27): Default `system` statt `user:max`-Fake.
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

    // Auto-Advance: Work-Product auf final → Ticket schliessen
    // (Handoff-Punkt 3).
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
  // Phase ORG: Bare-`user`-Marker (Legacy-Daten) bekommt keinen
  // erfundenen User-Namen mehr. System ist semantisch korrekt für
  // unattributed legacy-input.
  if (createdBy === "user") return "system";
  // Fallback: safe prefix.
  return `user:${createdBy}` as ActorType;
}
