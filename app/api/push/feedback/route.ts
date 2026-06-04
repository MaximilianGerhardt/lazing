/**
 * POST /api/push/feedback
 * ----------------------------------------------------------------
 * Pattern 6a Push-Telemetrie (2026-05-01).
 *
 * Empfängt Notification-Lifecycle-Events vom Service-Worker:
 *   - `clicked`   → Notification wurde geklickt (User-Engagement)
 *   - `dismissed` → Notification wurde geschlossen ohne Klick
 *
 * Schreibt die Events in den Event-Log via `emitEvent`. Phase 6b
 * (Decay-Algorithmus, kommt nach 7d Vorlauf) aggregiert die Events
 * pro `ruleId` und derived eine Dismiss-Rate, anhand derer Rules
 * adaptiv heruntergestuft werden.
 *
 * Auth (Dual-Path):
 *   1. Bearer $LAZYOS_PUSH_SECRET — für Server-zu-Server-Calls
 *      (z.B. wenn ein Backend-Cron Telemetrie injiziert)
 *   2. Session-Cookie `lazyos_session` — für SW-Calls aus dem
 *      Browser. SW läuft same-origin und schickt das HttpOnly-Cookie
 *      automatisch mit `credentials: 'include'`.
 *
 * Sensitivity: low (kein Klartext-Inhalt — nur ruleId/action/tag).
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

  // Path 2: Session-Cookie (Browser-SW Same-Origin)
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

  // segmentId fallback: lazyos (System-Workspace), reine Telemetrie-Events.
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
    // Telemetrie ist non-critical; bei DB-Stress nicht 500 zurückgeben,
    // sondern still failen damit der SW nicht endlos retried.
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
