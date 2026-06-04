/**
 * POST /api/routines/[id]/trigger — manual run.
 *
 * Response: { runId, status, output (first 2000 chars), error? }
 *
 * Runs synchronously — for long commands this can take up to 30 s (per
 * command). The UI client should show a loading state. For the
 * 3 seed routines this is enough.
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
