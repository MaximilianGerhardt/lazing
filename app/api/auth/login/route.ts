/**
 * POST /api/auth/login
 *
 * Body: { code: string }
 *
 * Verifies `code` against `LAZYOS_ACCESS_CODE` with a timing-safe
 * compare, then issues a session cookie. On failure we apply a
 * ~500-1000ms delay to make password-guessing expensive.
 *
 * CSRF: We require a same-origin `Origin` header (the login-page
 * fetches itself, so the browser will set this; curl/bot traffic
 * typically does not). SameSite=Lax on the cookie is our primary
 * defense; Origin-check is the belt-and-braces.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { timingSafeEqual } from "../../../../lib/security/crypto";
import { logAuthAttempt } from "../../../../lib/security/log";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "../../../../lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LoginSchema = z.object({
  code: z.string().min(1).max(256),
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
  const span = Math.max(0, maxMs - minMs);
  const ms = minMs + Math.floor(Math.random() * span);
  return new Promise((r) => setTimeout(r, ms));
}

function ipOf(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const ip = ipOf(req);
  const userAgent = req.headers.get("user-agent") ?? undefined;

  if (!sameOrigin(req)) {
    await logAuthAttempt({
      outcome: "fail",
      ip,
      userAgent,
      path: "/api/auth/login",
      reason: "cross_origin",
    });
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const config = readSessionConfig();
  if (!config) {
    await logAuthAttempt({
      outcome: "missing_code",
      ip,
      userAgent,
      path: "/api/auth/login",
      reason: "LAZYOS_ACCESS_CODE or LAZYOS_AUTH_SECRET not set",
    });
    return NextResponse.json(
      { error: "server_not_configured" },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const match = timingSafeEqual(parsed.data.code, config.accessCode);
  if (!match) {
    await delayRandom(500, 1000);
    await logAuthAttempt({
      outcome: "fail",
      ip,
      userAgent,
      path: "/api/auth/login",
      reason: "bad_code",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Phase ORG SP-2: Login-Cookie wird mit Owner-userId-Claim issued, sofern
  // der Owner-User schon in der DB existiert (SP-9-Backfill). Sonst Bootstrap.
  // So bleiben Cookies nach SP-9 sofort multi-user-ready ohne weiteren Step.
  const ownerUserId = await resolveOwnerUserIdFromDb();
  const value = await issueSessionCookieValue(config, {
    userId: ownerUserId ?? undefined,
  });
  await logAuthAttempt({
    outcome: "ok",
    ip,
    userAgent,
    path: "/api/auth/login",
  });

  const res = NextResponse.json({ ok: true, userId: ownerUserId ?? "max-bootstrap" });
  res.headers.set("Set-Cookie", sessionSetCookieHeader(value));
  return res;
}

/**
 * Liest den Owner-User aus der DB. Phase-1: Owner-Email steht als
 * LAZYOS_OWNER_EMAIL in env. Wenn der Backfill schon gelaufen ist,
 * existiert eine Row und wir kriegen die ULID. Sonst null.
 */
async function resolveOwnerUserIdFromDb(): Promise<string | null> {
  try {
    const email = process.env.LAZYOS_OWNER_EMAIL?.trim().toLowerCase();
    if (!email) {
      // Fallback: erster founder in der DB. Erlaubt dass eine fresh-installation
      // ohne LAZYOS_OWNER_EMAIL trotzdem funktioniert sobald ein Bootstrap-
      // Endpoint einen Founder angelegt hat.
      const { findFirstFounderUserId } = await import("@/lib/users/repo");
      return findFirstFounderUserId();
    }
    const { findUserByEmail } = await import("@/lib/users/repo");
    const user = findUserByEmail(email);
    return user?.id ?? null;
  } catch {
    return null;
  }
}
