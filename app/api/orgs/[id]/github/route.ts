/**
 * GET  /api/orgs/[id]/github  — Verbindungs-Status (member+)
 * DELETE /api/orgs/[id]/github — Verbindung trennen (admin+)
 *
 * Sicherheits-Gebot:
 *   - assertOrgRole prüft Org-Mitgliedschaft + Mindestrolle vor jeder Op.
 *   - Token wird NIEMALS in der Response zurückgegeben.
 *   - SQL immer WHERE org_id = ? (via getOrgCredential / deleteOrgCredential).
 */

import { NextResponse, type NextRequest } from "next/server";

import { assertOrgRole, OrgAuthError, orgAuthErrorToHttp } from "@/lib/orgs/auth";
import {
  deleteOrgCredential,
  getOrgCredentialMeta,
} from "@/lib/github/org-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/orgs/[id]/github
 * Mindestrolle: viewer (jeder Org-Member darf den Status sehen)
 *
 * Response:
 *   200 { connected: false }
 *   200 { connected: true, githubLogin: string, lastValidatedAt: number | null }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: orgId } = await params;

  try {
    assertOrgRole(req, orgId, "viewer");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }

  // getOrgCredentialMeta: public-safe, gibt kein encrypted_token zurück (MEDIUM-1).
  const meta = getOrgCredentialMeta(orgId);

  if (!meta) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    githubLogin: meta.github_login ?? null,
    lastValidatedAt: meta.last_validated_at ?? null,
  });
}

/**
 * DELETE /api/orgs/[id]/github
 * Mindestrolle: admin
 *
 * Response:
 *   200 { ok: true }
 *   404 { error: 'github-not-connected' }
 */
export async function DELETE(
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

  const deleted = deleteOrgCredential(orgId);
  if (!deleted) {
    return NextResponse.json(
      { error: "github-not-connected" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true });
}
