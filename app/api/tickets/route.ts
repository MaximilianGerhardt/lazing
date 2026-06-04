/**
 * Tickets Collection API
 * ----------------------
 *   GET  /api/tickets           – list tickets (proxied to VPS when bridge configured)
 *   POST /api/tickets           – create a ticket (LOCAL — write-via-proxy is Sprint 3)
 *
 * Auth: middleware gated. Session-Cookie (browser) oder Bearer-Token
 * (Agent-Server) haben Zugriff — siehe `middleware.ts`.
 *
 * Writes delegate an `lib/tickets/service.ts`, das intern `emitEvent`
 * aufruft. Keine direkten DB-Inserts hier. NOTE: POST still writes to
 * the local (Vercel-ephemeral) DB — this is a known gap, tracked for
 * Sprint 3. Read-path consistency is the current priority.
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import {
  CreateTicketBodySchema,
  parseListTicketsQuery,
} from "@/lib/tickets/schema";
import { createTicket, listTickets } from "@/lib/tickets/service";
import type { ActorType } from "@/lib/events/types";
import { bridgeOrLocal, emptyCollection } from "@/lib/vps-bridge/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/tickets
// ---------------------------------------------------------------------------

async function listTicketsLocal(req: NextRequest): Promise<Response> {
  const parsed = parseListTicketsQuery(req.nextUrl.searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.issues },
      { status: 400 },
    );
  }

  const q = parsed.value;
  // Phase IA.5 — wenn keine workspaceId mitkommt, fallback auf Org-Cookie.
  const cookieOrgId = req.cookies.get("lazyos.org")?.value
    ?? req.cookies.get("lazyos_org")?.value
    ?? null;
  const orgFilter = !q.workspaceId && cookieOrgId && cookieOrgId !== "__all__"
    ? cookieOrgId
    : undefined;
  try {
    const tickets = await listTickets({
      workspaceId: q.workspaceId,
      orgId: orgFilter,
      status: q.status,
      query: q.query,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });

    return NextResponse.json(
      {
        tickets,
        pagination: {
          limit: q.limit ?? 50,
          offset: q.offset ?? 0,
          count: tickets.length,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent(q.workspaceId ?? "lazyos", "api/tickets:GET", err);
    // For the bridgeOrLocal degraded path, prefer empty over 500 so the
    // UI keeps rendering. Surface the error via the degraded header only.
    return emptyCollection("tickets", {
      pagination: { limit: q.limit ?? 50, offset: q.offset ?? 0, count: 0 },
    });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return bridgeOrLocal<{ tickets: unknown[]; pagination?: unknown }>({
    path: "/api/tickets",
    searchParams: req.nextUrl.searchParams,
    fallback: () => listTicketsLocal(req),
    validate: (body): body is { tickets: unknown[]; pagination?: unknown } => {
      if (!body || typeof body !== "object") return false;
      return Array.isArray((body as { tickets?: unknown }).tickets);
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/tickets
// ---------------------------------------------------------------------------
// NOTE: Writes remain local for now. On Vercel this means the ticket lives
// only in /tmp and is invisible on the next cold-start. Acceptable tradeoff
// per sprint scope — Sprint 3 will proxy writes.

export async function POST(req: NextRequest): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = CreateTicketBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const ticket = await createTicket({
      workspaceId: parsed.data.workspaceId,
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

    return NextResponse.json(
      {
        ticket,
        url: `/tickets/${encodeURIComponent(ticket.id)}`,
      },
      { status: 201 },
    );
  } catch (err) {
    await emitErrorEvent(
      parsed.data.workspaceId,
      "api/tickets:POST",
      err,
    );
    return NextResponse.json(
      { error: "create_failed", message: errorMessage(err) },
      { status: 500 },
    );
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
