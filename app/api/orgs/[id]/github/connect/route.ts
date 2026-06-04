/**
 * POST /api/orgs/[id]/github/connect — PAT verknüpfen (admin+)
 *
 * Body: { token: string }
 *
 * Flow:
 *   1. assertOrgRole(req, orgId, 'admin') — fail-closed.
 *   2. validateToken(token) → live GitHub /user — prüft ob Token gültig.
 *   3. upsertOrgCredential — verschlüsselt + speichert.
 *   4. Response: { githubLogin, avatarUrl } — KEIN Token.
 *
 * Sicherheits-Gebot:
 *   - Token wird NIEMALS in Response, Log oder Error zurückgegeben.
 *   - Bei ungültigem Token → 400 (vor dem Speichern).
 *   - SQL immer WHERE org_id = ? (via upsertOrgCredential).
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
 * Mindestrolle: admin
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

  // Live-Validation gegen GitHub /user — bevor wir speichern.
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
    // Netzwerk-Timeout / unbekannter Fehler.
    return NextResponse.json(
      { error: "invalid-token", message: "GitHub-Validierung fehlgeschlagen." },
      { status: 400 },
    );
  }

  // Token ist gültig — verschlüsselt speichern.
  upsertOrgCredential({
    orgId,
    authKind: "pat",
    token: trimmedToken, // wird in upsertOrgCredential sofort verschlüsselt
    githubLogin: userInfo.login,
    githubUserId: userInfo.id,
    avatarUrl: userInfo.avatarUrl,
    scope: null,
    expiresAt: null,
  });

  // Token NIEMALS in der Response.
  return NextResponse.json({
    githubLogin: userInfo.login,
    avatarUrl: userInfo.avatarUrl ?? null,
  });
}
