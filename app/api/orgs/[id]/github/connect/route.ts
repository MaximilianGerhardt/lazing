/**
 * POST /api/orgs/[id]/github/connect — link a PAT (admin+)
 *
 * Body: { token: string }
 *
 * Flow:
 *   1. assertOrgRole(req, orgId, 'admin') — fail-closed.
 *   2. validateToken(token) → live GitHub /user — checks whether the token is valid.
 *   3. upsertOrgCredential — encrypts + stores.
 *   4. Response: { githubLogin, avatarUrl } — NO token.
 *
 * Security mandate:
 *   - The token is NEVER returned in a response, log or error.
 *   - On an invalid token → 400 (before storing).
 *   - SQL always WHERE org_id = ? (via upsertOrgCredential).
 */

import { NextResponse, type NextRequest } from "next/server";

import { assertOrgRole, OrgAuthError, orgAuthErrorToHttp } from "@/lib/orgs/auth";
import { validateToken, GitHubApiError } from "@/lib/github/client";
import { upsertOrgCredential } from "@/lib/github/org-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConnectBody {
  token?: unknown;
}

/**
 * POST /api/orgs/[id]/github/connect
 * Minimum role: admin
 *
 * Response:
 *   200 { githubLogin: string, avatarUrl: string | null }
 *   400 { error: 'invalid-token', message: string }
 *   400 { error: 'missing-token' }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: orgId } = await params;

  try {
    assertOrgRole(req, orgId, "admin");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }

  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const token = body?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    return NextResponse.json({ error: "missing-token" }, { status: 400 });
  }
  const trimmedToken = token.trim();

  // Live validation against GitHub /user — before we store.
  let userInfo: Awaited<ReturnType<typeof validateToken>>;
  try {
    userInfo = await validateToken(trimmedToken);
  } catch (err) {
    if (err instanceof GitHubApiError) {
      return NextResponse.json(
        { error: "invalid-token", message: err.githubMessage },
        { status: 400 },
      );
    }
    // Network timeout / unknown error.
    return NextResponse.json(
      { error: "invalid-token", message: "GitHub-Validierung fehlgeschlagen." },
      { status: 400 },
    );
  }

  // Token is valid — store encrypted.
  upsertOrgCredential({
    orgId,
    authKind: "pat",
    token: trimmedToken, // is encrypted immediately inside upsertOrgCredential
    githubLogin: userInfo.login,
    githubUserId: userInfo.id,
    avatarUrl: userInfo.avatarUrl,
    scope: null,
    expiresAt: null,
  });

  // NEVER the token in the response.
  return NextResponse.json({
    githubLogin: userInfo.login,
    avatarUrl: userInfo.avatarUrl ?? null,
  });
}
