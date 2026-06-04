/**
 * POST /api/onboarding/general-subchat — idempotent „Allgemein" default chat.
 *
 * Bundle-B / onboarding slice (2026-06-03). A dedicated, thin route — deliberately NOT
 * `POST /api/workspaces/[id]/subchats`, because this route leaves their `publicBaseUrl`
 * logic untouched (parallel session) and the onboarding flow does not need a
 * share link anyway (the founder fetches the external link later from the
 * existing subchat share UI).
 *
 * It calls `ensureGeneralSubchat` (idempotent — returns the existing active
 * external „Allgemein" sub-chat or creates it, 720h share token).
 *
 * Auth gate: identical to the subchats route (member-gated) —
 * `getEffectiveWorkspaceRole` + `canEditWorkspaceContent` + `hasRealWorkspaceMembership`.
 * The founder created the workspace themselves in step 2 (direct edit membership,
 * see POST /api/workspaces), so the gate passes.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { hasRealWorkspaceMembership } from "@/lib/security/membership";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { ensureGeneralSubchat } from "@/lib/subchats/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

export async function POST(req: NextRequest): Promise<Response> {
  let body: { workspaceId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const workspaceId = (body.workspaceId ?? "").trim();
  if (!WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  // Same gate the subchats route uses (member-gated).
  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sc = ensureGeneralSubchat(workspaceId, userId);
  return NextResponse.json(
    { subchat: { id: sc.id, title: sc.title, kind: sc.kind, status: sc.status } },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
