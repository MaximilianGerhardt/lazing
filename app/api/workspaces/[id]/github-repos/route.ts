/**
 * GET /api/workspaces/[id]/github-repos — list repos currently bound to
 * this workspace.
 */

import { NextResponse, type NextRequest } from "next/server";

import { listReposForWorkspace } from "@/lib/github/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const { id: workspaceId } = await ctx.params;
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }

  const rows = listReposForWorkspace(workspaceId);
  const bindings = rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    repoFullName: r.repo_full_name,
    repoUrl: r.repo_url,
    defaultBranch: r.default_branch,
    isPrivate: r.is_private === 1,
    description: r.description,
    lastSyncAt: r.last_sync_at,
    createdAt: r.created_at,
  }));

  return NextResponse.json({ bindings, count: bindings.length });
}
