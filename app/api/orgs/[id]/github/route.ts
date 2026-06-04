/**
 * GET  /api/orgs/[id]/github  — connection status (member+)
 * DELETE /api/orgs/[id]/github — disconnect (admin+)
 *
 * Security mandate:
 *   - assertOrgRole checks org membership + minimum role before every op.
 *   - The token is NEVER returned in the response.
 *   - SQL always WHERE org_id = ? (via getOrgCredential / deleteOrgCredential).
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
 * Minimum role: viewer (every org member may see the status)
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

  // getOrgCredentialMeta: public-safe, does not return encrypted_token (MEDIUM-1).
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
 * Minimum role: admin
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
