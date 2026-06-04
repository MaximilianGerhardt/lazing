/**
 * POST /api/routines/tick
 *
 * Called by the systemd timer (Bearer $LAZYOS_CRON_KEY). Runs all
 * due active cron routines.
 *
 * Deliberately POST instead of GET, so browser preloaders/URL scanners do not
 * fire the routines by accident.
 *
 * This endpoint is public in middleware.ts — authorization happens
 * here inline via a Bearer token. Anti-CSRF is sufficient, because POST without
 * a body is required.
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
