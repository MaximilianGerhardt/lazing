/**
 * GET /api/auth/github/init — kicks off the GitHub OAuth flow.
 *
 * Behaviour:
 *   - 412 if LAZYOS_GITHUB_CLIENT_ID / SECRET / CALLBACK env vars
 *     aren't set (UI should fall back to PAT-flow).
 *   - 401 if no user cookie.
 *   - 302 redirect to https://github.com/login/oauth/authorize?…
 *     Sets a short-lived httpOnly cookie `lazyos_gh_state` holding the
 *     random state token. The /callback verifies it matches.
 */

import { randomBytes } from "node:crypto";

import { type NextRequest, NextResponse } from "next/server";

import { buildAuthorizeUrl, readOAuthConfig } from "@/lib/github/oauth";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const config = readOAuthConfig();
  if (!config) {
    return NextResponse.json(
      {
        error: "oauth_not_configured",
        hint:
          "Setze LAZYOS_GITHUB_CLIENT_ID + LAZYOS_GITHUB_CLIENT_SECRET + " +
          "LAZYOS_GITHUB_OAUTH_CALLBACK oder nutze den PAT-Flow auf /settings/github.",
      },
      { status: 412 },
    );
  }

  const state = randomBytes(24).toString("hex");
  const url = buildAuthorizeUrl(config, state);

  // Optional return_to — the callback honours it (only same-origin paths).
  const returnTo = req.nextUrl.searchParams.get("return_to");
  const safeReturnTo =
    returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
      ? returnTo
      : null;

  const res = NextResponse.redirect(url, { status: 302 });
  res.cookies.set("lazyos_gh_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.nextUrl.protocol === "https:",
    path: "/api/auth/github",
    maxAge: 600, // 10 min
  });
  if (safeReturnTo) {
    res.cookies.set("lazyos_gh_return_to", safeReturnTo, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.nextUrl.protocol === "https:",
      path: "/api/auth/github",
      maxAge: 600,
    });
  }
  return res;
}
