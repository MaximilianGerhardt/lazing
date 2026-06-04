/**
 * POST /api/routines/tick
 *
 * Vom systemd-Timer aufgerufen (Bearer $LAZYOS_CRON_KEY). Führt alle
 * fälligen aktiven Cron-Routinen aus.
 *
 * Bewusst POST statt GET, damit Browser-Preloader/URL-Scanner die
 * Routinen nicht ausversehen feuern.
 *
 * Dieser Endpoint ist public in middleware.ts — Authorization erfolgt
 * hier inline via Bearer-Token. Anti-CSRF reicht aus, weil POST ohne
 * Body verlangt wird.
 */

import { NextResponse, type NextRequest } from "next/server";

import { emitErrorEvent } from "@/lib/events/emit";
import { tick } from "@/lib/routines/runner";
import { verifyBearer } from "@/lib/security/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  return verifyBearer(req, process.env.LAZYOS_CRON_KEY).ok;
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await tick();
    return NextResponse.json(
      {
        ok: true,
        checkedAt: result.checkedAt,
        candidates: result.candidates,
        executed: result.executed,
        skipped: result.skipped,
        runs: result.runs.map((r) => ({
          runId: r.runId,
          routineId: r.routineId,
          status: r.status,
          error: r.error ?? null,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    await emitErrorEvent("lazyos", "api/routines/tick", err);
    return NextResponse.json(
      {
        error: "tick_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
