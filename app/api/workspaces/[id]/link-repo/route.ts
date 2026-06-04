/**
 * POST   /api/workspaces/[id]/link-repo   — link a GitHub repo to this workspace.
 *
 * Body: { repoFullName: "owner/repo" }
 *
 * Flow:
 *   1. Auth: currentUserIdResolved.
 *   2. Validate workspace_id format.
 *   3. Confirm workspace exists.
 *   4. Read user's GitHub credential. 412 if missing.
 *   5. fetchRepo(token, fullName) — enriches default_branch + private flag.
 *   6. linkRepoToWorkspace — re-binds if already linked elsewhere.
 *
 * Re-bind behaviour: if `owner/repo` is currently linked to workspace A
 * and the user POSTs the same repo with workspace B, the binding moves
 * (UNIQUE(user_id, repo_full_name) enforces 1 binding per repo). The
 * response carries `rebindedFrom: workspaceA` so the UI can confirm.
 *
 * DELETE /api/workspaces/[id]/link-repo?bindingId=…  — unlink.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import {
  GitHubApiError,
  fetchRepo,
  isValidRepoFullName,
} from "@/lib/github/client";
import {
  findRepoBinding,
  linkRepoToWorkspace,
  unlinkRepoBinding,
} from "@/lib/github/repo";
import { resolveGithubTokenForWorkspace } from "@/lib/github/token-resolver";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PostBody {
  repoFullName?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

function workspaceExists(id: string): boolean {
  const db = getDb();
  const row = db.$raw
    .prepare("SELECT id FROM workspaces WHERE id = ?")
    .get(id) as { id?: string } | undefined;
  return !!row?.id;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const { id: workspaceId } = await ctx.params;
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }
  if (!workspaceExists(workspaceId)) {
    return NextResponse.json({ error: "workspace_not_found" }, { status: 404 });
  }

  // Cross-org leak protection (Critic INFO-1, 2026-05-24): only someone who is
  // allowed to write to THIS workspace (→ via org inheritance = org membership)
  // may use the possibly org-wide GitHub token. resolveGithubTokenForWorkspace
  // itself checks NO membership — without this gate an org-A member could reach
  // org-B's token via an org-B workspace id. getEffectiveWorkspaceRole resolves
  // the workspace→org role; non-member → null → 403.
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const repoFullName =
    typeof body.repoFullName === "string" ? body.repoFullName.trim() : "";
  if (!isValidRepoFullName(repoFullName)) {
    return NextResponse.json(
      {
        error: "invalid_repo_full_name",
        hint: 'Erwarte "owner/repo" (alphanumerisch, "-", "_", ".").',
      },
      { status: 400 },
    );
  }

  const resolved = resolveGithubTokenForWorkspace(workspaceId, userId);
  if (!resolved) {
    return NextResponse.json(
      { error: "github-not-connected" },
      { status: 404 },
    );
  }
  const { token } = resolved;

  // Check if it's currently bound somewhere else (for rebind UX).
  const existing = findRepoBinding(userId, repoFullName);
  const rebindedFrom =
    existing && existing.workspace_id !== workspaceId ? existing.workspace_id : null;

  let repo;
  try {
    repo = await fetchRepo(token, repoFullName);
  } catch (err) {
    if (err instanceof GitHubApiError) {
      if (err.status === 404) {
        return NextResponse.json(
          { error: "repo_not_found", githubMessage: err.githubMessage },
          { status: 404 },
        );
      }
      if (err.status === 401 || err.status === 403) {
        return NextResponse.json(
          { error: "github_access_denied", githubMessage: err.githubMessage },
          { status: 403 },
        );
      }
      return NextResponse.json(
        { error: "github_api_error", githubMessage: err.githubMessage },
        { status: 502 },
      );
    }
    return NextResponse.json(
      {
        error: "github_unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  const row = linkRepoToWorkspace({
    workspaceId,
    userId,
    repoFullName: repo.fullName,
    repoUrl: repo.htmlUrl,
    defaultBranch: repo.defaultBranch,
    isPrivate: repo.isPrivate,
    description: repo.description,
  });

  return NextResponse.json(
    {
      binding: {
        id: row.id,
        workspaceId: row.workspace_id,
        repoFullName: row.repo_full_name,
        repoUrl: row.repo_url,
        defaultBranch: row.default_branch,
        isPrivate: row.is_private === 1,
        description: row.description,
        createdAt: row.created_at,
      },
      rebindedFrom,
    },
    { status: existing ? 200 : 201 },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const { id: workspaceId } = await ctx.params;
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }

  // Consistency with POST (Critic INFO-1): only workspace editors (→ org member)
  // may unlink repo bindings of this workspace.
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const bindingId = url.searchParams.get("bindingId");
  if (!bindingId) {
    return NextResponse.json(
      { error: "missing_binding_id", hint: "?bindingId=… erforderlich" },
      { status: 400 },
    );
  }

  const removed = unlinkRepoBinding(bindingId, userId);
  if (!removed) {
    return NextResponse.json({ error: "binding_not_found" }, { status: 404 });
  }
  return NextResponse.json({ unlinked: true, bindingId });
}
