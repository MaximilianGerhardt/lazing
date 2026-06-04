/**
 * POST /api/chat/history/[workspaceId]/clear
 *
 * „Verlauf leeren" — server-seitig (2026-06-02). Setzt einen append-only
 * Clear-Marker (`chat_history_cleared`) für den Workspace. Die History-
 * Projektion (`GET /api/chat/history/[workspaceId]`) blendet danach alle
 * `chat_message`-Events VOR dem Marker aus. Es wird NICHTS gelöscht — der
 * Event-Log (Wahrheits-Schicht, append-only) bleibt vollständig; der Clear ist
 * reversibel (Marker entfernen ⇒ History zurück).
 *
 * Vorher war „Verlauf leeren" rein client-seitig (localStorage) — die History
 * kam beim Reload / auf einem anderen Gerät zurück. Dieser Endpoint macht den
 * Clear cross-device-persistent.
 *
 * Auth: Session-Cookie (gleicher Pattern wie GET). Der Marker trägt den
 * verifizierten User als Actor (N8-Audit: wer hat geleert).
 */

import { NextResponse } from "next/server";

import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "@/lib/security/session";
import { emitChatHistoryCleared } from "@/lib/events/emit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACE_ID_REGEX = /^(?:__org_root__:)?[a-z0-9_()][a-z0-9_()-]{0,63}$/i;

export async function POST(
  req: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const cookieCfg = readSessionConfig();
  if (!cookieCfg) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }
  const cookieValue = readSessionCookie(req.headers.get("cookie"));
  const verified = await verifySessionCookieValue(cookieValue, cookieCfg);
  if (!verified.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await context.params;
  if (!workspaceId || !WORKSPACE_ID_REGEX.test(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }

  try {
    const actor = verified.userId ? (`user:${verified.userId}` as const) : "system";
    const ev = await emitChatHistoryCleared(workspaceId, actor);
    return NextResponse.json(
      { ok: true, clearedAt: ev.createdAt, eventId: ev.id },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.warn(
      "[chat/history/clear] emit failed:",
      err instanceof Error ? err.message : String(err),
    );
    return NextResponse.json({ error: "clear_failed" }, { status: 500 });
  }
}
