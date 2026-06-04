/**
 * /api/cloud/stats?workspace=<id>
 * Returns artifact_count, total_bytes, folder_count for the given workspace.
 * Used by the surface `<surface:cloud-browser>` and the cloud-page sidebar
 * to render status pills.
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

  // Explicitly check workspace existence AND read permission.
  // Otherwise: info leak about the existence of archived / non-existent workspaces.
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

  // The actor is read so it is traceable in the server log; the stats
  // endpoint itself writes no audit log (too chatty on every
  // polling tick).
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
