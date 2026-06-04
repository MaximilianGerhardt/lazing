/**
 * POST /api/heartbeat/tick
 *
 * Triggered by systemd-Timer (every 60s) OR manually by the agent.
 *
 * Auth (Bearer only — endpoint is whitelisted in middleware so cookies
 * are not required):
 *   - `Authorization: Bearer <LAZYOS_CRON_KEY>`    (cron preferred)
 *   - `Authorization: Bearer <LAZYOS_CHAT_KEY>`    (agent-side fallback)
 *
 * Fail-closed: wenn keiner der beiden Secrets gesetzt ist, geben wir 503.
 *
 * Returns:
 *   { ok: true, probed: number, duration_ms: number,
 *     errors: Array<{workspace: string, reason: string}>,
 *     decisions: Array<{workspaceId, status, lagSec}> }
 */

import { NextResponse, type NextRequest } from "next/server";

import { sweepHeartbeats } from "@/lib/heartbeat/runner";
import { sweepDueRoutines } from "@/lib/routines/scheduler-loop";
import { extractBearer, timingSafeEqual } from "@/lib/security/bearer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest): {
  ok: boolean;
  reason?: "no_secret" | "no_bearer" | "bad_secret";
} {
  const cronKey = process.env.LAZYOS_CRON_KEY ?? "";
  const chatKey = process.env.LAZYOS_CHAT_KEY ?? "";

  if (cronKey.length === 0 && chatKey.length === 0) {
    return { ok: false, reason: "no_secret" };
  }

  const token = extractBearer(req);
  if (!token) return { ok: false, reason: "no_bearer" };

  if (cronKey.length > 0 && timingSafeEqual(token, cronKey)) return { ok: true };
  if (chatKey.length > 0 && timingSafeEqual(token, chatKey)) return { ok: true };
  return { ok: false, reason: "bad_secret" };
}

async function runTick(): Promise<Response> {
  const startedAt = Date.now();

  // Belt-and-suspenders: sweep due cron-routines on every tick so that a
  // systemd-Timer hitting this endpoint also drives the scheduler.  Non-fatal
  // — heartbeat result is returned regardless of routine-sweep outcome.
  void sweepDueRoutines(startedAt).catch(() => {
    // Intentionally swallowed — sweep failures must never break the heartbeat.
  });

  try {
    const result = await sweepHeartbeats(startedAt);
    const errors = result.decisions
      .filter((d) => d.status === "error")
      .map((d) => ({
        workspace: d.workspaceId,
        reason: d.reasons[0] ?? "unknown",
      }));

    return NextResponse.json({
      ok: true,
      probed: result.decisions.length,
      duration_ms: Date.now() - startedAt,
      errors,
      decisions: result.decisions.map((d) => ({
        workspaceId: d.workspaceId,
        status: d.status,
        lagSec: d.lagSec,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: "sweep_failed",
        message: msg,
        duration_ms: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const auth = authorized(req);
  if (!auth.ok) {
    const status = auth.reason === "no_secret" ? 503 : 401;
    return NextResponse.json(
      {
        ok: false,
        error: auth.reason === "no_secret" ? "server_not_configured" : "unauthorized",
        reason: auth.reason,
      },
      { status },
    );
  }
  return runTick();
}

// Convenience: `curl http://.../api/heartbeat/tick` (GET) also works — same
// auth rules apply. Useful for quick manual smoke-checks and for systemd
// (which uses curl, GET is the zero-body default).
export async function GET(req: NextRequest): Promise<Response> {
  const auth = authorized(req);
  if (!auth.ok) {
    const status = auth.reason === "no_secret" ? 503 : 401;
    return NextResponse.json(
      {
        ok: false,
        error: auth.reason === "no_secret" ? "server_not_configured" : "unauthorized",
        reason: auth.reason,
      },
      { status },
    );
  }
  return runTick();
}
