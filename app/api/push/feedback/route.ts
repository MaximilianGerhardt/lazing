/**
 * POST /api/push/feedback
 * ----------------------------------------------------------------
 * Pattern 6a push telemetry (2026-05-01).
 *
 * Receives notification lifecycle events from the service worker:
 *   - `clicked`   → notification was clicked (user engagement)
 *   - `dismissed` → notification was closed without a click
 *
 * Writes the events into the event log via `emitEvent`. Phase 6b
 * (decay algorithm, arrives after a 7d lead time) aggregates the events
 * per `ruleId` and derives a dismiss rate, by which rules are
 * adaptively downgraded.
 *
 * Auth (dual-path):
 *   1. Bearer $LAZYOS_PUSH_SECRET — for server-to-server calls
 *      (e.g. when a backend cron injects telemetry)
 *   2. Session cookie `lazyos_session` — for SW calls from the
 *      browser. The SW runs same-origin and sends the HttpOnly cookie
 *      automatically with `credentials: 'include'`.
 *
 * Sensitivity: low (no plaintext content — only ruleId/action/tag).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { emitEvent } from "@/lib/events/emit";
import type { EventType, SegmentId } from "@/lib/events/types";
import { verifyBearer } from "@/lib/security/bearer";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FeedbackSchema = z
  .object({
    ruleId: z.string().min(1).max(120),
    action: z.enum(["clicked", "dismissed"]),
    tag: z.string().max(200).optional(),
    segmentId: z.string().min(1).max(64).optional(),
  })
  .strict();

async function authorized(req: NextRequest): Promise<boolean> {
  // Path 1: Bearer
  const bearer = verifyBearer(req, process.env.LAZYOS_PUSH_SECRET);
  if (bearer.ok) return true;

  // Path 2: session cookie (browser SW same-origin)
  const cfg = readSessionConfig();
  if (!cfg) return false;
  const cookieHeader = req.headers.get("cookie");
  const raw = readSessionCookie(cookieHeader);
  if (!raw) return false;
  const result = await verifySessionCookieValue(raw, cfg);
  return result.ok;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await authorized(req))) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json" },
      { status: 400 },
    );
  }

  const parsed = FeedbackSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "validation failed",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
      { status: 400 },
    );
  }

  const { ruleId, action, tag, segmentId } = parsed.data;
  const eventType: EventType =
    action === "clicked"
      ? "notification_clicked"
      : "notification_dismissed_without_action";

  // segmentId fallback: lazyos (system workspace), pure telemetry events.
  const seg: SegmentId = segmentId ?? "lazyos";

  try {
    await emitEvent({
      segmentId: seg,
      entityType: "push_rule",
      entityId: ruleId,
      eventType,
      actor: "system",
      payload: { ruleId, action, tag },
      sensitivity: "low",
    });
  } catch (err) {
    // Telemetry is non-critical; under DB stress do not return 500,
    // but fail silently so the SW does not retry endlessly.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      "[push/feedback] emitEvent failed (non-fatal):",
      msg,
    );
    return NextResponse.json(
      { ok: false, error: "emit failed", detail: msg },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
