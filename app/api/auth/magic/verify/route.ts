/**
 * GET /api/auth/magic/verify?token=<raw>
 *
 * Verifies + consumes the magic token (single-use). On success:
 *   1. ensureUserFromEmail (create or find the user row)
 *   2. If intent='invite-org' → upsert org_memberships
 *   3. If intent='invite-workspace' → upsert workspace_memberships
 *   4. Issue a session cookie with the real user.id as the claim
 *   5. Redirect to /onboarding (if email not yet verified) or /
 *
 * Failure cases:
 *   - invalid-token / expired / consumed → redirect /login?error=...
 *
 * Auth: NO auth check (the magic token IS the auth mechanism itself).
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";

import { writeAudit } from "@/lib/audit/write";
import { verifyAndConsumeToken } from "@/lib/auth/magic-link";
import { getDb } from "@/db/client";
import { orgMemberships, workspaceMemberships } from "@/db/schema/memberships";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "@/lib/security/session";
import { ulid } from "@/lib/ulid";
import { ensureUserFromEmail } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const token = req.nextUrl.searchParams.get("token");
  const ip = req.headers.get("x-forwarded-for");
  const ua = req.headers.get("user-agent");

  if (!token) {
    return redirectToLogin(req, "missing-token");
  }

  const result = verifyAndConsumeToken(token, {
    ip: ip ?? null,
    userAgent: ua ?? null,
  });

  if (!result.ok) {
    writeAudit({
      actor: "anon",
      action:
        result.reason === "consumed"
          ? "magic.duplicate-consume"
          : "magic.expired",
      payload: { reason: result.reason },
      ip,
      userAgent: ua,
    });
    return redirectToLogin(req, result.reason);
  }

  const tokenRow = result.token;
  const email = tokenRow.email;

  // 1. User upsert.
  const user = ensureUserFromEmail({
    email,
    displayName: email.split("@")[0] ?? "User",
  });

  // 2a. Login intent (no invite): guarantee at least viewer membership
  // in the default org, so /orgs is not empty.
  if (tokenRow.intent === "login") {
    try {
      const { DEFAULT_ORG_ID } = await import("@/lib/orgs/constants");
      const { findOrgById } = await import("@/lib/orgs/repo");
      if (findOrgById(DEFAULT_ORG_ID)) {
        upsertOrgMembership({
          userId: user.id,
          orgId: DEFAULT_ORG_ID,
          role: "viewer",
          invitedByUserId: null,
        });
      }
    } catch {
      /* non-fatal — the user just gets solo mode */
    }
  }

  // 2. Membership upsert depending on intent.
  if (tokenRow.intent === "invite-org" && tokenRow.intentOrgId) {
    upsertOrgMembership({
      userId: user.id,
      orgId: tokenRow.intentOrgId,
      role: tokenRow.intentRole ?? "member",
      invitedByUserId: tokenRow.issuedByUserId,
    });
    writeAudit({
      actor: `user:${user.id}`,
      action: "member.joined",
      orgId: tokenRow.intentOrgId,
      targetUserId: user.id,
      payload: { via: "magic-link", role: tokenRow.intentRole },
      ip,
      userAgent: ua,
    });
  } else if (tokenRow.intent === "invite-workspace" && tokenRow.intentWorkspaceId) {
    upsertWorkspaceMembership({
      userId: user.id,
      workspaceId: tokenRow.intentWorkspaceId,
      role: tokenRow.intentRole ?? "viewer",
      invitedByUserId: tokenRow.issuedByUserId,
    });
    writeAudit({
      actor: `user:${user.id}`,
      action: "member.joined",
      workspaceId: tokenRow.intentWorkspaceId,
      targetUserId: user.id,
      payload: { via: "magic-link", role: tokenRow.intentRole },
      ip,
      userAgent: ua,
    });
  }

  // 3. Issue the session cookie.
  const cfg = readSessionConfig();
  if (!cfg) {
    return NextResponse.json(
      { error: "server_not_configured" },
      { status: 503 },
    );
  }
  const cookieValue = await issueSessionCookieValue(cfg, {
    userId: user.id,
  });

  writeAudit({
    actor: `user:${user.id}`,
    action: "magic.verified",
    payload: { intent: tokenRow.intent, tokenId: tokenRow.id },
    ip,
    userAgent: ua,
  });

  // 4. Redirect target: onboarding for first-time redeemers, otherwise /.
  // Public URL from the forwarded headers (the Cloudflare tunnel hides 127.0.0.1).
  const onboardingDone = !!user.onboardingCompletedAt;
  const redirectTo = onboardingDone ? "/" : "/onboarding";
  const redirectUrl = new URL(redirectTo, publicOrigin(req));

  const res = NextResponse.redirect(redirectUrl, { status: 303 });
  res.headers.set(
    "Set-Cookie",
    sessionSetCookieHeader(cookieValue, {
      isSecure: req.nextUrl.protocol === "https:" || (req.headers.get("x-forwarded-proto") === "https"),
    }),
  );
  return res;
}

function publicOrigin(req: NextRequest): string {
  const envUrl = process.env.LAZYOS_PUBLIC_URL?.trim().replace(/\/$/, "");
  if (envUrl) return envUrl;
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto") ?? "https";
  if (fwdHost) return `${fwdProto}://${fwdHost}`;
  return req.nextUrl.origin;
}

function redirectToLogin(req: NextRequest, reason: string): Response {
  const url = new URL("/login", publicOrigin(req));
  url.searchParams.set("magic-error", reason);
  return NextResponse.redirect(url, { status: 303 });
}

interface UpsertOrgMemberInput {
  userId: string;
  orgId: string;
  role: string;
  invitedByUserId?: string | null;
}

function upsertOrgMembership(input: UpsertOrgMemberInput): void {
  const db = getDb();
  const existing = db
    .select()
    .from(orgMemberships)
    .where(
      sql`${orgMemberships.userId} = ${input.userId} AND ${orgMemberships.orgId} = ${input.orgId}`,
    )
    .limit(1)
    .all();
  const now = new Date();
  if (existing.length > 0) {
    db.update(orgMemberships)
      .set({ role: input.role, updatedAt: now })
      .where(eq(orgMemberships.id, existing[0].id))
      .run();
    return;
  }
  db.insert(orgMemberships)
    .values({
      id: `om_${ulid()}`,
      userId: input.userId,
      orgId: input.orgId,
      role: input.role,
      invitedByUserId: input.invitedByUserId ?? null,
      joinedAt: now,
      updatedAt: now,
    })
    .run();
}

interface UpsertWsMemberInput {
  userId: string;
  workspaceId: string;
  role: string;
  invitedByUserId?: string | null;
}

function upsertWorkspaceMembership(input: UpsertWsMemberInput): void {
  const db = getDb();
  const existing = db
    .select()
    .from(workspaceMemberships)
    .where(
      sql`${workspaceMemberships.userId} = ${input.userId} AND ${workspaceMemberships.workspaceId} = ${input.workspaceId}`,
    )
    .limit(1)
    .all();
  const now = new Date();
  if (existing.length > 0) {
    db.update(workspaceMemberships)
      .set({ role: input.role, updatedAt: now })
      .where(eq(workspaceMemberships.id, existing[0].id))
      .run();
    return;
  }
  db.insert(workspaceMemberships)
    .values({
      id: `wm_${ulid()}`,
      userId: input.userId,
      workspaceId: input.workspaceId,
      role: input.role,
      inheritsFromOrg: false, // explicit override on the workspace invite
      invitedByUserId: input.invitedByUserId ?? null,
      joinedAt: now,
      updatedAt: now,
    })
    .run();
}
