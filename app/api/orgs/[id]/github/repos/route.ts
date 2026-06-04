/**
 * GET /api/orgs/[id]/github/repos — Live-Repo-Liste der Org-GitHub-Verbindung (member+)
 *
 * Flow:
 *   1. assertOrgRole(req, orgId, 'member') — fail-closed.
 *   2. decryptOrgToken(orgId) — Token holen + entschlüsseln.
 *   3. listUserRepos(token) — live GitHub-API-Call.
 *   4. Response: Repo-Liste (name, full_name, private, default_branch, url).
 *
 * Sicherheits-Gebot:
 *   - Token wird NIEMALS in Response oder Log zurückgegeben.
 *   - Kein Credential → 404 { error: 'github-not-connected' }.
 *   - SQL immer WHERE org_id = ? (via decryptOrgToken → getOrgCredential).
 */

import { NextResponse, type NextRequest } from "next/server";

import { assertOrgRole, OrgAuthError, orgAuthErrorToHttp } from "@/lib/orgs/auth";
import { listUserRepos, GitHubApiError } from "@/lib/github/client";
import { decryptOrgToken } from "@/lib/github/org-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/orgs/[id]/github/repos
 * Mindestrolle: member
 *
 * Response:
 *   200 { repos: Array<{ name, fullName, isPrivate, defaultBranch, url }> }
 *   404 { error: 'github-not-connected' }
 *   502 { error: 'github-api-error', message: string }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: orgId } = await params;

  try {
    assertOrgRole(req, orgId, "member");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }

  // WHERE org_id = ? ist in decryptOrgToken → getOrgCredential eingebaut.
  // "list-repos" als N8-Zweck für die Audit-Row.
  const plainToken = decryptOrgToken(orgId, "list-repos");
  if (!plainToken) {
    return NextResponse.json(
      { error: "github-not-connected" },
      { status: 404 },
    );
  }

  let repos: Awaited<ReturnType<typeof listUserRepos>>;
  try {
    repos = await listUserRepos(plainToken);
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return NextResponse.json(
        { error: "github-api-error", message: err.githubMessage },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: "github-api-error", message: "GitHub-API nicht erreichbar." },
      { status: 502 },
    );
  }

  // Token NIEMALS in der Response — wir projizieren nur die nötigen Felder.
  const repoList = repos.map((r) => ({
    name: r.name,
    fullName: r.fullName,
    isPrivate: r.isPrivate,
    defaultBranch: r.defaultBranch,
    url: r.htmlUrl,
  }));

  return NextResponse.json({ repos: repoList });
}
