/**
 * POST /api/auth/logout
 *
 * Clears the session cookie. Server-side session invalidation is a
 * no-op in our stateless HMAC model — the cookie itself is the only
 * artifact, and deleting it on the client revokes access. If we ever
 * need server-side revocation we add a `session_id` claim and a
 * `revoked_sessions` table.
 */

import { NextResponse } from "next/server";

import { logAuthAttempt } from "../../../../lib/security/log";
import { clearSessionCookieHeader } from "../../../../lib/security/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ipOf(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: Request): Promise<Response> {
  await logAuthAttempt({
    outcome: "ok",
    ip: ipOf(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
    path: "/api/auth/logout",
    reason: "logout",
  });
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearSessionCookieHeader());
  return res;
}
