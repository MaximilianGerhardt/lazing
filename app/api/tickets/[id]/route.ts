/**
 * Single Ticket API
 * -----------------
 *   GET    /api/tickets/:id    – single ticket (proxied to VPS when bridge configured)
 *   PATCH  /api/tickets/:id    – update (LOCAL — writes via proxy land in Sprint 3)
 *   DELETE /api/tickets/:id    – close (LOCAL — soft-delete emits `closed`)
 *
 * Auth via middleware (same as collection route).
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { UpdateTicketBodySchema } from "@/lib/tickets/schema";
import {
  TicketNotFoundError,
  closeTicket,
  getTicket,
  updateTicket,
} from "@/lib/tickets/service";
import type { ActorType } from "@/lib/events/types";
import { bridgeOrLocal, degradedNotFound } from "@/lib/vps-bridge/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/tickets/:id
// ---------------------------------------------------------------------------

async function readTicketLocal(id: string): Promise<Response> {
  try {
    const ticket = await getTicket(id);
    if (!ticket) {
      // In fallback mode we do not know whether the VPS would have had
      // the ticket — 404 is the honest local answer, but we surface it
      // via degradedNotFound so clients know it may be transient.
      return degradedNotFound(`ticket:${id}`);
    }
    return NextResponse.json(
      { ticket },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", `api/tickets/${id}:GET`, err);
    return degradedNotFound(`ticket:${id}`);
  }
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  return bridgeOrLocal<{ ticket: unknown }>({
    path: `/api/tickets/${encodeURIComponent(id)}`,
    fallback: () => readTicketLocal(id),
    validate: (body): body is { ticket: unknown } => {
      return !!body && typeof body === "object" && "ticket" in body;
    },
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/tickets/:id
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = UpdateTicketBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const ticket = await updateTicket(id, {
      title: parsed.data.title,
      body: parsed.data.body,
      prio: parsed.data.prio,
      due: parsed.data.due,
      tags: parsed.data.tags,
      assignee: parsed.data.assignee,
      status: parsed.data.status,
      workflowState: parsed.data.workflowState,
      actor: (parsed.data.actor ?? undefined) as ActorType | undefined,
      sessionId: parsed.data.sessionId,
      workstreamId: parsed.data.workstreamId,
      parentTicketId: parsed.data.parentTicketId,
    });
    return NextResponse.json({ ticket });
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await emitErrorEvent("lazyos", `api/tickets/${id}:PATCH`, err);
    return NextResponse.json(
      { error: "update_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/tickets/:id  (soft-close)
// ---------------------------------------------------------------------------

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  try {
    const ticket = await closeTicket(id);
    return NextResponse.json({ ticket, closed: true });
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await emitErrorEvent("lazyos", `api/tickets/${id}:DELETE`, err);
    return NextResponse.json(
      { error: "close_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
