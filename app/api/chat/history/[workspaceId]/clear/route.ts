/**
 * POST /api/chat/history/[workspaceId]/clear
 *
 * „Verlauf leeren" — server-side (2026-06-02). Sets an append-only
 * clear marker (`chat_history_cleared`) for the workspace. The history
 * projection (`GET /api/chat/history/[workspaceId]`) then hides all
 * `chat_message` events BEFORE the marker. NOTHING is deleted — the
 * event log (truth layer, append-only) stays complete; the clear is
 * reversible (remove the marker ⇒ history back).
 *
 * Previously „Verlauf leeren" was purely client-side (localStorage) — the history
 * came back on reload / on another device. This endpoint makes the
 * clear cross-device persistent.
 *
 * Auth: session cookie (same pattern as GET). The marker carries the
 * verified user as the actor (N8 audit: who cleared).
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
