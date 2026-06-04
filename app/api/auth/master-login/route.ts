/**
 * POST /api/auth/master-login
 *
 * Solo self-host login WITHOUT mail. Accepts the ENV master code
 * `LAZYOS_ACCESS_CODE` and logs in as the **first founder user**.
 *
 * Use case: open-source forks that want to run without Resend, or
 * solo setups where the operator + user are the same person. Requires
 * that at least one founder exists in the DB (otherwise → 410, then
 * create the first founder via /api/auth/bootstrap).
 *
 * Security:
 *   - Same-origin check (CSRF)
 *   - timing-safe compare against LAZYOS_ACCESS_CODE
 *   - 500-1000ms delay on errors
 *   - rate limit via edge middleware (existing)
 *   - audit log on every attempt
 *
 * Unlike /api/auth/bootstrap: NO 410 after the first success.
 * The master code always remains a master key for the operator.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAudit } from "@/lib/audit/write";
import { timingSafeEqual } from "@/lib/security/crypto";
import { logAuthAttempt } from "@/lib/security/log";
import {
  issueSessionCookieValue,
  readSessionConfig,
  sessionSetCookieHeader,
} from "@/lib/security/session";
import { findFirstFounderUserId } from "@/lib/users/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MasterLoginSchema = z.object({
  accessCode: z.string().min(1).max(256),
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
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const ip = ipOf(req);
  const userAgent = req.headers.get("user-agent") ?? undefined;

  if (!sameOrigin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const config = readSessionConfig();
  if (!config) {
    return NextResponse.json(
      { error: "server_not_configured" },
      { status: 500 },
    );
  }

  const accessCode = process.env.LAZYOS_ACCESS_CODE?.trim();
  if (!accessCode || accessCode.length < 16) {
    return NextResponse.json(
      { error: "master-login-disabled", hint: "LAZYOS_ACCESS_CODE not set" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = MasterLoginSchema.safeParse(body);
  if (!parsed.success) {
    await delayRandom(500, 1000);
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!timingSafeEqual(parsed.data.accessCode, accessCode)) {
    await delayRandom(500, 1000);
    await logAuthAttempt({
      outcome: "fail",
      ip,
      userAgent,
      path: "/api/auth/master-login",
      reason: "bad_access_code",
    });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // First founder user in the DB. If none exists, the user should go
  // via /api/auth/bootstrap (= the actual setup path).
  const founderId = findFirstFounderUserId();
  if (!founderId) {
    return NextResponse.json(
      {
        error: "no-founder",
        hint: "Lege einen Founder via /api/auth/bootstrap an, danach klappt Master-Login.",
      },
      { status: 409 },
    );
  }

  const cookieValue = await issueSessionCookieValue(config, {
    userId: founderId,
  });

  await logAuthAttempt({
    outcome: "ok",
    ip,
    userAgent,
    path: "/api/auth/master-login",
  });
  writeAudit({
    actor: `user:${founderId}`,
    action: "auth.master-login",
    targetUserId: founderId,
    payload: { method: "access-code" },
    ip,
    userAgent,
  });

  const res = NextResponse.json({
    ok: true,
    userId: founderId,
    redirectTo: "/",
  });
  res.headers.set("Set-Cookie", sessionSetCookieHeader(cookieValue));
  return res;
}
