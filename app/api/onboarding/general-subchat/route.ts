/**
 * POST /api/onboarding/general-subchat — idempotenter „Allgemein"-Default-Chat.
 *
 * Bundle-B / Onboarding-Slice (2026-06-03). Eigene, dünne Route — bewusst NICHT
 * `POST /api/workspaces/[id]/subchats`, weil diese Route deren `publicBaseUrl`-
 * Logik unangetastet lässt (parallele Session) und der Onboarding-Flow ohnehin
 * keinen Share-Link braucht (der Founder holt den externen Link später aus der
 * bestehenden Subchat-Share-UI).
 *
 * Sie ruft `ensureGeneralSubchat` (idempotent — gibt den vorhandenen aktiven
 * external-„Allgemein"-Sub-Chat zurück oder legt ihn an, 720h Share-Token).
 *
 * Auth-Gate: identisch zur Subchats-Route (member-gated) —
 * `getEffectiveWorkspaceRole` + `canEditWorkspaceContent` + `hasRealWorkspaceMembership`.
 * Der Founder hat den Workspace in Schritt 2 selbst erstellt (direkte Edit-Membership,
 * siehe POST /api/workspaces), daher passiert das Gate.
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
