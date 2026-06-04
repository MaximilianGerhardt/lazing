/**
 * PATCH  /api/orgs/[id]/members/[memberId]  { role }   — change role
 * DELETE /api/orgs/[id]/members/[memberId]              — remove member
 *
 * Founder-Schutz: letzter Founder kann nicht entfernt/herabgestuft werden.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { writeAudit } from "@/lib/audit/write";
import { orgMemberships } from "@/db/schema/memberships";
import {
  assertOrgRole,
  OrgAuthError,
  orgAuthErrorToHttp,
} from "@/lib/orgs/auth";
import {
  countFoundersInOrg,
  deleteOrgMembership,
  updateOrgMembershipRole,
} from "@/lib/orgs/repo";
import { currentActor } from "@/lib/security/subject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["admin", "member", "viewer", "guest"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
): Promise<Response> {
  const { id, memberId } = await params;
  try {
    assertOrgRole(req, id, "admin");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }
  let body: { role?: string };
  try {
    body = (await req.json()) as { role?: string };
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  const role = body.role;
  if (!role || !ALLOWED_ROLES.includes(role)) {
    return NextResponse.json({ error: "invalid-role" }, { status: 400 });
  }
  const target = findMembership(memberId);
  if (!target || target.orgId !== id) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (target.role === "founder") {
    if (countFoundersInOrg(id) <= 1) {
      return NextResponse.json(
        { error: "last-founder", message: "Letzter Founder kann nicht herabgestuft werden." },
        { status: 409 },
      );
    }
  }
  updateOrgMembershipRole(memberId, role as "admin" | "member" | "viewer" | "guest");
  writeAudit({
    actor: currentActor(req),
    action: "member.role-changed",
    orgId: id,
    targetUserId: target.userId,
    payload: { from: target.role, to: role },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
): Promise<Response> {
  const { id, memberId } = await params;
  try {
    assertOrgRole(req, id, "admin");
  } catch (err) {
    if (err instanceof OrgAuthError) {
      const m = orgAuthErrorToHttp(err);
      return NextResponse.json(m.body, { status: m.status });
    }
    throw err;
  }
  const target = findMembership(memberId);
  if (!target || target.orgId !== id) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (target.role === "founder" && countFoundersInOrg(id) <= 1) {
    return NextResponse.json(
      { error: "last-founder", message: "Letzter Founder kann nicht entfernt werden." },
      { status: 409 },
    );
  }
  deleteOrgMembership(memberId);
  writeAudit({
    actor: currentActor(req),
    action: "member.removed",
    orgId: id,
    targetUserId: target.userId,
  });
  return NextResponse.json({ ok: true });
}

interface MembershipRow {
  id: string;
  userId: string;
  orgId: string;
  role: string;
}

function findMembership(memberId: string): MembershipRow | null {
  const db = getDb();
  const rows = db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.id, memberId))
    .limit(1)
    .all();
  const r = rows[0];
  return r
    ? {
        id: r.id,
        userId: r.userId,
        orgId: r.orgId,
        role: r.role,
      }
    : null;
}
