/**
 * GET /api/github/repos — list repos the connected user has access to.
 *
 * Query params:
 *   - ?affiliation=owner,collaborator,organization_member  (default)
 *   - ?perPage=100  (1-100)
 *
 * Auth: must have a github_credentials row. Returns 412 if not.
 *
 * Used by:
 *   - /settings/github "Connected repos" list.
 *   - Workspace-Settings "Link a Repo" picker.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  GitHubApiError,
  decryptGithubToken,
  listUserRepos,
} from "@/lib/github/client";
import { findCredentialForUser, touchValidated } from "@/lib/github/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const cred = findCredentialForUser(userId);
  if (!cred) {
    return NextResponse.json(
      {
        error: "github_not_connected",
        hint: "Verbinde dein GitHub-Konto auf /settings/github.",
      },
      { status: 412 },
    );
  }

  const url = new URL(req.url);
  const perPageRaw = url.searchParams.get("perPage");
  const perPage = perPageRaw ? Math.max(1, Math.min(100, Number.parseInt(perPageRaw, 10))) : 100;
  const affiliation =
    url.searchParams.get("affiliation") ?? "owner,collaborator,organization_member";

  let token: string;
  try {
    token = decryptGithubToken(cred.encrypted_token);
  } catch (err) {
    return NextResponse.json(
      {
        error: "decrypt_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }

  try {
    const repos = await listUserRepos(token, { perPage, affiliation });
    touchValidated(userId);
    return NextResponse.json({
      repos,
      count: repos.length,
      connected: { login: cred.github_login, avatarUrl: cred.avatar_url },
    });
  } catch (err) {
    if (err instanceof GitHubApiError) {
      const status = err.status === 401 || err.status === 403 ? 401 : 502;
      return NextResponse.json(
        {
          error: status === 401 ? "github_token_invalid" : "github_api_error",
          message: err.githubMessage,
          githubStatus: err.status,
          endpoint: err.endpoint,
        },
        { status },
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
}
