/**
 * POST /api/auth/password/login — email + password login.
 *
 * Body: { email, password }. On success issues the session cookie (same as the
 * magic-link verify path). Generic error + timing delay on any failure (no user,
 * no password set, wrong password) to avoid user enumeration. Same-origin (CSRF).
 *
 * Users without a password (magic-link only) simply can't log in here — they use
 * the magic link. Setting a password is opt-in via /api/auth/password/set.
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "@/db/client";
import { users } from "@/db/schema/users";
import { verifyPassword } from "@/lib/security/password";
import { logAuthAttempt } from "@/lib/security/log";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "@/lib/security/session";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function delayRandom(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.floor(Math.random() * Math.max(0, maxMs - minMs));
  return new Promise((r) => setTimeout(r, ms));
}

function ipOf(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

function ossMode(): boolean {
  return ["1", "true", "on"].includes((process.env.LAZYOS_OSS_MODE ?? "").trim().toLowerCase());
}

export async function POST(req: NextRequest): Promise<Response> {
  const ip = ipOf(req);
  const userAgent = req.headers.get("user-agent") ?? undefined;

  if (!sameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const cfg = readSessionConfig();
  if (!cfg) {
    return NextResponse.json({ error: "server_not_configured" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const db = getDb();
  const row = db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      status: users.status,
      deletedAt: users.deletedAt,
      onboardingCompletedAt: users.onboardingCompletedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all()[0];

  const ok =
    row != null &&
    row.status === "active" &&
    row.deletedAt == null &&
    verifyPassword(parsed.data.password, row.passwordHash);

  if (!ok) {
    await delayRandom(500, 1000);
    await logAuthAttempt({
      outcome: "fail",
      ip,
      userAgent,
      path: "/api/auth/password/login",
      reason: "bad_credentials",
    });
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const cookieValue = await issueSessionCookieValue(cfg, { userId: row.id });
  await logAuthAttempt({ outcome: "ok", ip, userAgent, path: "/api/auth/password/login" });
  writeAudit({
    actor: `user:${row.id}`,
    action: "auth.password-login",
    targetUserId: row.id,
    ip,
    userAgent,
  });

  const redirectTo = row.onboardingCompletedAt
    ? "/"
    : ossMode()
      ? "/oss-onboarding"
      : "/onboarding";
  const isSecure =
    req.nextUrl.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  const res = NextResponse.json({ ok: true, redirectTo });
  res.headers.set("Set-Cookie", sessionSetCookieHeader(cookieValue, { isSecure }));
  return res;
}
