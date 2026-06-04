/**
 * POST /api/ctx/compact-snapshot
 *
 * Phase CTX — User-getriggerter Compact-Helper. Nimmt einen Workspace,
 * baut einen Snapshot, schreibt ihn als neuen Block ins Plan-File und
 * gibt eine Summary für ein UI-Toast zurück.
 *
 * Body: { workspaceId: string, planFile?: string }
 *
 * Auth: User muss eingeloggt sein UND mind. viewer im Workspace.
 */

import { NextResponse, type NextRequest } from "next/server";

import { buildSnapshot } from "@/lib/ctx/snapshot";
import { prependPlanSnapshot } from "@/lib/ctx/plan-writer";
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  workspaceId?: string;
  planFile?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) {
    return NextResponse.json(
      { error: "missing-workspaceId" },
      { status: 400 },
    );
  }
  if (!canReadWorkspace(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json(
      { error: "forbidden", hint: "Kein Zugriff auf den Workspace." },
      { status: 403 },
    );
  }

  const snapshot = await buildSnapshot({ workspaceId, userId });
  const writeResult = await prependPlanSnapshot(snapshot.block, body.planFile);

  return NextResponse.json({
    ok: true,
    summary: snapshot.summary,
    eventCount: snapshot.eventCount,
    planPath: writeResult.planPath,
    bytesWritten: writeResult.bytesWritten,
    snapshotsRetained: writeResult.snapshotsRetained,
  });
}
