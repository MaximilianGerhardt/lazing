/**
 * POST /api/auth/master-login
 *
 * Solo-Self-Host Login OHNE Mail. Akzeptiert den ENV-Master-Code
 * `LAZYOS_ACCESS_CODE` und loggt als der **erste Founder-User** ein.
 *
 * Anwendungsfall: Open-Source-Forks die ohne Resend laufen wollen, oder
 * Solo-Setups wo der Operator + User dieselbe Person ist. Setzt voraus,
 * dass mindestens ein Founder in der DB existiert (sonst → 410, dann
 * via /api/auth/bootstrap den ersten Founder anlegen).
 *
 * Sicherheit:
 *   - Same-Origin-Check (CSRF)
 *   - timing-safe Compare gegen LAZYOS_ACCESS_CODE
 *   - 500-1000ms Delay bei Fehlern
 *   - Rate-Limit über Edge-Middleware (existing)
 *   - Audit-Log auf jeden Versuch
 *
 * Im Unterschied zu /api/auth/bootstrap: KEIN 410 nach erstem Erfolg.
 * Der Master-Code bleibt für den Operator immer ein Master-Key.
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

  // Erster Founder-User in der DB. Wenn keiner existiert, soll User über
  // /api/auth/bootstrap gehen (= eigentlicher Setup-Pfad).
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
