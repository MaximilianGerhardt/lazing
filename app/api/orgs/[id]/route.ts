/**
 * GET   /api/orgs/[id]  — Org-Detail (full incl. brand fields)
 * PATCH /api/orgs/[id]  — update brand/legal fields (admin+ required)
 */

import { NextResponse, type NextRequest } from "next/server";

import { writeAudit } from "@/lib/audit/write";
import {
  assertOrgRole,
  OrgAuthError,
  orgAuthErrorToHttp,
} from "@/lib/orgs/auth";
import {
  findOrgById,
  updateOrgBrand,
  type UpdateOrgBrandInput,
} from "@/lib/orgs/repo";
import { currentActor } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    assertOrgRole(req, id, "viewer");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }
  const org = findOrgById(id);
  if (!org) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  return NextResponse.json({ org });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  let auth;
  try {
    auth = assertOrgRole(req, id, "admin");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }

  let body: UpdateOrgBrandInput;
  try {
    body = (await req.json()) as UpdateOrgBrandInput;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  // Sanity: brandColors maximal 6 hex-Werte
  if (Array.isArray(body.brandColors)) {
    body.brandColors = body.brandColors
      .filter((c) => typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c))
      .slice(0, 6);
  }
  if (Array.isArray(body.addressLines)) {
    body.addressLines = body.addressLines
      .filter((l) => typeof l === "string" && l.length <= 200)
      .slice(0, 8);
  }

  updateOrgBrand(id, body);
  writeAudit({
    actor: currentActor(req),
    action: "org.brand-updated",
    orgId: id,
    targetUserId: auth.userId,
    payload: { fields: Object.keys(body) },
  });

  const fresh = findOrgById(id);
  return NextResponse.json({ org: fresh });
}
