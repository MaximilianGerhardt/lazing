/**
 * POST /api/workspaces/[id]/live-warn-ack — Stream X1 · 2026-05-28.
 *
 * Records the owner's response to the one-shot `<surface:live-warn>` Card.
 * Idempotent: persists ONE supersede-chained belief row per call. Re-clicking
 * just appends another row (chain continues; no duplicates in listBeliefs).
 *
 * Body: { decision: 'ack' | 'decline' }
 * Auth: member of the workspace (canEditWorkspaceContent).
 *
 * SECURITY: no secret in body, no secret in response. The persisted belief
 * (workspace_beliefs) carries verbatim N1 text only — no credential values.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { recordLiveWarnAck, type LiveWarnDecision } from "@/lib/connectors/live-warn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isValidWorkspaceId(id: string): boolean {
  // Same shape used across this directory (alphanumerics, dashes, underscores).
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function isValidDecision(v: unknown): v is LiveWarnDecision {
  return v === "ack" || v === "decline";
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const { id: wsId } = await ctx.params;
  if (!isValidWorkspaceId(wsId)) {
    return NextResponse.json(
      { error: "invalid_workspace_id" },
      { status: 400 },
    );
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const decision =
    body && typeof body === "object" && "decision" in body
      ? (body as { decision: unknown }).decision
      : undefined;

  if (!isValidDecision(decision)) {
    return NextResponse.json(
      { error: "invalid_decision", message: "decision must be 'ack' | 'decline'" },
      { status: 400 },
    );
  }

  try {
    const belief = recordLiveWarnAck(wsId, decision);
    return NextResponse.json({
      ok: true,
      decision,
      beliefId: belief.id,
      // No secret material — only the meta envelope of the persisted ack row.
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "persist_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
