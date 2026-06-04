/**
 * DELETE /api/chat/snapshot/[pendingPromptId]
 *
 * Streaming-Recovery · 2026-04-27. Löscht eine `streaming_snapshots`-Row.
 * Wird vom Frontend aufgerufen für:
 *   - "Verwerfen"-Button in der aborted-StreamingBubble
 *   - Cleanup nach erfolgreichem "Regenerieren" (alte Snapshot-Karteileiche entfernen)
 *
 * Auth: Cookie-basiert (gleicher Pattern wie GET /api/chat/history/[workspaceId]).
 *
 * Response: 204 No Content bei Erfolg, 404 wenn Row nicht (mehr) existiert,
 *           401 unauthenticated, 400 bei ungültigem Param.
 */

import { NextResponse } from "next/server";

import { getDb } from "@/db/client";
import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from "@/lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENDING_PROMPT_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

export async function DELETE(
  req: Request,
  context: { params: Promise<{ pendingPromptId: string }> },
): Promise<Response> {
  const cookieCfg = readSessionConfig();
  if (!cookieCfg) {
    return NextResponse.json(
      { error: "auth_not_configured" },
      { status: 503 },
    );
  }
  const cookieValue = readSessionCookie(req.headers.get("cookie"));
  const verified = await verifySessionCookieValue(cookieValue, cookieCfg);
  if (!verified.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { pendingPromptId } = await context.params;
  if (!pendingPromptId || !PENDING_PROMPT_ID_REGEX.test(pendingPromptId)) {
    return NextResponse.json(
      { error: "invalid_pending_prompt_id" },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    const result = db.$raw
      .prepare(`DELETE FROM streaming_snapshots WHERE pending_prompt_id = ?`)
      .run(pendingPromptId) as { changes: number };

    if (result.changes === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error(
      "[chat/snapshot] DELETE failed for",
      pendingPromptId,
      err,
    );
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
