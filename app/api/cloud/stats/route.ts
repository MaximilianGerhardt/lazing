/**
 * /api/cloud/stats?workspace=<id>
 * Returns artifact_count, total_bytes, folder_count for the given workspace.
 * Wird vom Surface `<surface:cloud-browser>` und der Cloud-Page-Sidebar
 * benutzt um Status-Pills zu rendern.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveActor } from "@/lib/cloud/actor";
import { CloudError, workspaceCloudStats } from "@/lib/cloud/service";
import { canReadFromCloud } from "@/lib/cloud/sensitivity";
import { getWorkspace } from "@/lib/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const workspace = req.nextUrl.searchParams.get("workspace");
  if (!workspace) {
    return NextResponse.json({ error: "missing-workspace" }, { status: 400 });
  }

  // Workspace-Existenz UND Read-Berechtigung explizit prüfen.
  // Sonst: Info-Leak auf Bestand archivierter / non-existenter Workspaces.
  const ws = await getWorkspace(workspace);
  if (!ws) {
    return NextResponse.json(
      { error: "workspace-not-found" },
      { status: 404 },
    );
  }
  const check = canReadFromCloud(ws);
  if (!check.ok) {
    return NextResponse.json(
      { error: "archived-blocked", message: check.reason },
      { status: 403 },
    );
  }

  // Actor wird gelesen damit es im Server-Log nachvollziehbar ist; Stats-
  // Endpoint schreibt selber keinen Audit-Log (zu chatty bei jedem
  // Polling-Tick).
  void resolveActor(req);

  try {
    const stats = await workspaceCloudStats(workspace);
    return NextResponse.json({ workspace, stats });
  } catch (err) {
    if (err instanceof CloudError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: "internal", message: (err as Error).message },
      { status: 500 },
    );
  }
}
