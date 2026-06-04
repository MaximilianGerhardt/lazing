/**
 * POST /api/auth/magic/issue
 * Body: { email, intent?: "login"|"invite-org"|"invite-workspace", orgId?, workspaceId?, role? }
 *
 * Issues a magic-link token + sends an email via the email adapter (SP-4).
 *
 * Privacy: ALWAYS returns `{ sent: true }` — no hint whether the email exists
 * or whether there is a user account behind it (enumeration protection).
 *
 * Rate limit: max 5 tokens / hour / email.
 *
 * Auth: public path for intent='login'. For invite-* the caller must be
 * authenticated (middleware-gated; we check `currentSubject`).
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  canIssueTokenForEmail,
  issueToken,
  MAGIC_TOKEN_TTL_MS,
} from "@/lib/auth/magic-link";
import { writeAudit } from "@/lib/audit/write";
import { BRAND_NAME } from "@/lib/brand";
import { sendEmail } from "@/lib/email/send";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "@/lib/security/session";
import { currentActor, currentUserId } from "@/lib/security/subject";
import { ensureUserFromEmail } from "@/lib/users/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_INTENTS = new Set(["login", "invite-org", "invite-workspace"]);

interface IssueBody {
  email?: string;
  intent?: string;
  orgId?: string | null;
  workspaceId?: string | null;
  role?: string;
  displayName?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  let body: IssueBody;
  try {
    body = (await req.json()) as IssueBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  const intent = (body.intent ?? "login").trim();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "missing-email" }, { status: 400 });
  }
  // Single-user pin (2026-05-01): only a whitelisted email may magic-login.
  // Privacy: on block still return {sent:true} (no enumeration hint).
  const allowedEmails = (process.env.LAZYOS_ALLOWED_EMAILS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowedEmails.length > 0 && !allowedEmails.includes(email)) {
    writeAudit({
      actor: currentActor(req),
      action: "magic.expired",
      payload: { email, intent, reason: "email-not-allowlisted" },
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    return NextResponse.json({ sent: true, blocked: true });
  }
  if (!VALID_INTENTS.has(intent)) {
    return NextResponse.json(
      { error: "invalid-intent", allowed: Array.from(VALID_INTENTS) },
      { status: 400 },
    );
  }

  // Auth check for invite intents.
  const issuerId = currentUserId(req);
  if (intent !== "login" && !issuerId) {
    return NextResponse.json(
      { error: "auth-required", hint: "Invite-Intents brauchen User-Login" },
      { status: 401 },
    );
  }

  // DEV AUTO-LOGIN (2026-05-23): if LAZYOS_DEV_AUTO_LOGIN=1 AND login intent
  // AND email is in the allow-list → IMMEDIATELY set the session cookie +
  // autoLoginUsed=true in the response, NO mail send, NO token DB write. Only
  // for the local dev environment. Production must not set this ENV.
  if (
    intent === "login" &&
    process.env.LAZYOS_DEV_AUTO_LOGIN === "1"
  ) {
    const cfg = readSessionConfig();
    if (!cfg) {
      return NextResponse.json(
        { error: "server_not_configured" },
        { status: 503 },
      );
    }
    // Create or find the user row (idempotent — same path as verify).
    const user = ensureUserFromEmail({
      email,
      displayName: body.displayName ?? email.split("@")[0] ?? "User",
    });
    // Guarantee viewer membership in the default org (same path as verify).
    try {
      const { DEFAULT_ORG_ID } = await import("@/lib/orgs/constants");
      const { findOrgById } = await import("@/lib/orgs/repo");
      if (findOrgById(DEFAULT_ORG_ID)) {
        const { getDb } = await import("@/db/client");
        const { orgMemberships } = await import("@/db/schema/memberships");
        const { sql } = await import("drizzle-orm");
        const { ulid } = await import("@/lib/ulid");
        const db = getDb();
        const existing = db
          .select()
          .from(orgMemberships)
          .where(
            sql`${orgMemberships.userId} = ${user.id} AND ${orgMemberships.orgId} = ${DEFAULT_ORG_ID}`,
          )
          .limit(1)
          .all();
        if (existing.length === 0) {
          db.insert(orgMemberships)
            .values({
              id: `om_${ulid()}`,
              userId: user.id,
              orgId: DEFAULT_ORG_ID,
              role: "viewer",
              invitedByUserId: null,
              joinedAt: new Date(),
              updatedAt: new Date(),
            })
            .run();
        }
      }
    } catch {
      /* non-fatal — solo mode is enough */
    }
    const cookieValue = await issueSessionCookieValue(cfg, {
      userId: user.id,
    });
    const onboardingDone = !!user.onboardingCompletedAt;
    const redirectTo = onboardingDone ? "/" : "/onboarding";
    writeAudit({
      actor: `user:${user.id}`,
      action: "magic.verified",
      payload: {
        intent: "login",
        method: "dev-auto-login",
        email,
      },
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    const res = NextResponse.json({
      sent: true,
      autoLoginUsed: true,
      redirectTo,
      userId: user.id,
    });
    const isSecure =
      req.nextUrl.protocol === "https:" ||
      req.headers.get("x-forwarded-proto") === "https";
    res.headers.set(
      "Set-Cookie",
      sessionSetCookieHeader(cookieValue, { isSecure }),
    );
    return res;
  }

  // Rate-limit check.
  const rateOk = canIssueTokenForEmail(email);
  if (!rateOk.ok) {
    writeAudit({
      actor: currentActor(req),
      action: "magic.expired",
      payload: {
        email,
        intent,
        reason: "rate-limited",
        recentCount: rateOk.recentCount,
      },
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });
    // Privacy: still return `sent:true` (no enumeration hint).
    return NextResponse.json({ sent: true, rateLimited: true });
  }

  let issued: ReturnType<typeof issueToken>;
  try {
    issued = issueToken({
      email,
      intent: intent as "login" | "invite-org" | "invite-workspace",
      intentOrgId: body.orgId ?? null,
      intentWorkspaceId: body.workspaceId ?? null,
      intentRole: body.role ?? null,
      issuedByUserId: issuerId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "issue-failed", message: (err as Error).message },
      { status: 400 },
    );
  }

  // Build the verify URL — prefer the public URL from ENV (the Cloudflare
  // tunnel hides the real origin behind 127.0.0.1:4204). Fallback:
  // X-Forwarded-Host/Proto, then nextUrl.origin as a last resort.
  const publicUrlEnv = process.env.LAZYOS_PUBLIC_URL?.trim().replace(/\/$/, "");
  const fwdHost = req.headers.get("x-forwarded-host");
  const fwdProto = req.headers.get("x-forwarded-proto") ?? "https";
  const origin = publicUrlEnv
    ? publicUrlEnv
    : fwdHost
      ? `${fwdProto}://${fwdHost}`
      : req.nextUrl.origin;
  const verifyUrl = `${origin}/api/auth/magic/verify?token=${encodeURIComponent(issued.rawToken)}`;

  const expiresInMin = Math.round(MAGIC_TOKEN_TTL_MS / 60_000);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();

  // Send the email.
  // Resolve the inviter name from issuerId (for invite mails, no more hardcode).
  let inviterName = BRAND_NAME;
  if (issuerId) {
    try {
      const { findActiveUserById } = await import("@/lib/users/repo");
      const issuer = findActiveUserById(issuerId);
      if (issuer) inviterName = issuer.displayName;
    } catch {
      /* fall back to default */
    }
  }

  const sendInput =
    intent === "login"
      ? {
          to: email,
          template: "magic-login" as const,
          vars: {
            displayName: body.displayName ?? email.split("@")[0] ?? "User",
            verifyUrl,
            expiresInMin,
            ipHint: ip ?? "",
          },
        }
      : intent === "invite-org"
        ? {
            to: email,
            template: "org-invite" as const,
            vars: {
              displayName: body.displayName ?? email.split("@")[0] ?? "User",
              inviterName,
              orgName: body.orgId ?? "Organisation",
              role: body.role ?? "member",
              verifyUrl,
              expiresInMin,
            },
          }
        : {
            to: email,
            template: "workspace-invite" as const,
            vars: {
              displayName: body.displayName ?? email.split("@")[0] ?? "User",
              inviterName,
              workspaceLabel: body.workspaceId ?? "Workspace",
              role: body.role ?? "viewer",
              verifyUrl,
              expiresInMin,
            },
          };

  const sendResult = await sendEmail(sendInput);

  writeAudit({
    actor: currentActor(req),
    action: "magic.issued",
    orgId: body.orgId ?? null,
    workspaceId: body.workspaceId ?? null,
    payload: {
      tokenId: issued.tokenId,
      intent,
      email,
      provider: sendResult.provider,
      messageId: sendResult.messageId,
      sendOk: sendResult.ok,
      sendError: sendResult.error,
    },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  // Privacy: return sent:true regardless of whether the email exists or not.
  return NextResponse.json({
    sent: true,
    expiresInMin,
  });
}
