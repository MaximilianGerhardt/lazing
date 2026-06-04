/**
 * GET /api/tickets/:id/timeline
 * -----------------------------
 * Returns every event for a single ticket, chronological oldest→newest.
 * No projection folding — raw event log. Use this on the detail view
 * Timeline-Tab.
 *
 * Proxied to the VPS when the bridge is configured, otherwise falls back
 * to the local event store.
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { TicketNotFoundError, getTimeline } from "@/lib/tickets/service";
import { bridgeOrLocal, emptyCollection } from "@/lib/vps-bridge/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

async function readTimelineLocal(id: string): Promise<Response> {
  try {
    const timeline = await getTimeline(id);
    return NextResponse.json(
      {
        timeline,
        count: timeline.length,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof TicketNotFoundError) {
      // Same reasoning as the detail route: return empty rather than 404
      // in fallback mode — the VPS may still know about the ticket.
      return emptyCollection("timeline", { count: 0 });
    }
    await emitErrorEvent("lazyos", `api/tickets/${id}/timeline:GET`, err);
    return emptyCollection("timeline", { count: 0 });
  }
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  return bridgeOrLocal<{ timeline: unknown[]; count: number }>({
    path: `/api/tickets/${encodeURIComponent(id)}/timeline`,
    fallback: () => readTimelineLocal(id),
    validate: (body): body is { timeline: unknown[]; count: number } => {
      if (!body || typeof body !== "object") return false;
      return Array.isArray((body as { timeline?: unknown }).timeline);
    },
  });
}
