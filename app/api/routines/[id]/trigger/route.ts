/**
 * POST /api/routines/[id]/trigger — Manual-Run.
 *
 * Response: { runId, status, output (first 2000 chars), error? }
 *
 * Läuft synchron — bei langen Commands kann das bis 30 s dauern (pro
 * Command). Der UI-Client sollte einen Loading-State zeigen. Für die
 * 3 Seed-Routinen reicht das.
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { executeRoutine } from "@/lib/routines/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_OUTPUT_BYTES = 2000;

export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const result = await executeRoutine(id, { trigger: "manual" });

    return NextResponse.json(
      {
        runId: result.runId,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        output: result.output.slice(0, MAX_OUTPUT_BYTES),
        outputTruncated: result.output.length > MAX_OUTPUT_BYTES,
        deliveryRef: result.deliveryRef ?? null,
        error: result.error ?? null,
      },
      { status: result.status === "failure" ? 500 : 200 },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", `api/routines/${id}/trigger`, err);
    return NextResponse.json(
      {
        error: "trigger_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
