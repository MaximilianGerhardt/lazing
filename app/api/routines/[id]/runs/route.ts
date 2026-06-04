/**
 * GET /api/routines/[id]/runs
 *
 * Last N (max 100) run records for a routine. Default limit: 20.
 *
 * Payload output is NOT included (potentially large). The detail
 * page can call a separate endpoint for individual runs — for
 * now the history list is enough.
 *
 * Proxied to the VPS when the bridge is configured, otherwise served
 * from the local run-history store.
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { getRunHistory } from "@/lib/routines/runner";
import { bridgeOrLocal, emptyCollection } from "@/lib/vps-bridge/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function readRunsLocal(id: string, limit: number): Promise<Response> {
  try {
    const history = await getRunHistory(id, limit);
    return NextResponse.json(
      { runs: history, limit },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", `api/routines/${id}/runs:GET`, err);
    return emptyCollection("runs", { limit });
  }
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  const limitRaw = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitRaw ?? "20", 10) || 20, 1), 100);

  return bridgeOrLocal<{ runs: unknown[]; limit: number }>({
    path: `/api/routines/${encodeURIComponent(id)}/runs`,
    searchParams: req.nextUrl.searchParams,
    fallback: () => readRunsLocal(id, limit),
    validate: (body): body is { runs: unknown[]; limit: number } => {
      if (!body || typeof body !== "object") return false;
      return Array.isArray((body as { runs?: unknown }).runs);
    },
  });
}
