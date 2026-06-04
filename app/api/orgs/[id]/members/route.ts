/**
 * GET  /api/orgs/[id]/members
 * POST /api/orgs/[id]/members  { email, role, displayName? }
 *   → triggert Magic-Link-Issue (intent='invite-org')
 */

import { NextResponse, type NextRequest } from "next/server";

import { writeAudit } from "@/lib/audit/write";
import { issueToken, MAGIC_TOKEN_TTL_MS } from "@/lib/auth/magic-link";
import { sendEmail } from "@/lib/email/send";
import {
  assertOrgRole,
  OrgAuthError,
  orgAuthErrorToHttp,
} from "@/lib/orgs/auth";
import { findOrgById, listOrgMembers } from "@/lib/orgs/repo";
import { currentActor } from "@/lib/security/subject";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { findUserById } from "@/lib/users/repo";

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
  const members = listOrgMembers(id);
  return NextResponse.json({
    members: members.map((m) => ({
      id: m.membership.id,
      userId: m.user.id,
      email: m.user.email,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
      status: m.user.status,
      role: m.membership.role,
      joinedAt:
        m.membership.joinedAt instanceof Date
          ? m.membership.joinedAt.toISOString()
          : m.membership.joinedAt,
    })),
  });
}

interface InviteBody {
  email?: string;
  role?: string;
  displayName?: string;
}

export async function POST(
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

  let body: InviteBody;
  try {
    body = (await req.json()) as InviteBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const role = (body.role ?? "member").trim();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "missing-email" }, { status: 400 });
  }
  if (!["admin", "member", "viewer", "guest"].includes(role)) {
    return NextResponse.json({ error: "invalid-role" }, { status: 400 });
  }
  // founder kann nur von founder ernannt werden, hier blockieren wir
  // founder-Invites komplett (nur DB-Direct via Backfill).

  const issuerId = currentUserIdResolved(req);
  const issuer = issuerId ? findUserById(issuerId) : null;
  const org = findOrgById(id);
  if (!org) {
    return NextResponse.json({ error: "org-not-found" }, { status: 404 });
  }

  const issued = issueToken({
    email,
    intent: "invite-org",
    intentOrgId: id,
    intentRole: role,
    issuedByUserId: auth.userId,
  });

  const origin = req.nextUrl.origin;
  const verifyUrl = `${origin}/api/auth/magic/verify?token=${encodeURIComponent(issued.rawToken)}`;
  const expiresInMin = Math.round(MAGIC_TOKEN_TTL_MS / 60_000);

  const sendResult = await sendEmail({
    to: email,
    template: "org-invite",
    vars: {
      displayName: body.displayName ?? email.split("@")[0] ?? "User",
      inviterName: issuer?.displayName ?? "Ein Teamkollege",
      orgName: org.name,
      role,
      verifyUrl,
      expiresInMin,
    },
  });

  writeAudit({
    actor: currentActor(req),
    action: "member.invited",
    orgId: id,
    payload: {
      email,
      role,
      tokenId: issued.tokenId,
      provider: sendResult.provider,
      sendOk: sendResult.ok,
    },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return NextResponse.json({
    sent: true,
    expiresInMin,
    provider: sendResult.provider,
    deliveredVia: sendResult.ok && sendResult.provider === "resend"
      ? "email"
      : "console-log",
  });
}
