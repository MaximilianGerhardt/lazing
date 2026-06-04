/**
 * GET /api/auth/github/callback?code=…&state=…
 *
 * GitHub redirects here after the user clicks "Authorize". We:
 *   1. Verify `state` matches the httpOnly cookie set by /init.
 *   2. POST /login/oauth/access_token to swap `code` → token.
 *   3. Validate the token (GET /user).
 *   4. Encrypt + upsert into github_credentials with auth_kind='oauth'.
 *   5. Redirect to /settings/github?connected=1.
 *
 * On any error, redirect to /settings/github?error=<code> so the UI
 * can show a toast.
 */

import { type NextRequest, NextResponse } from "next/server";

import { validateToken } from "@/lib/github/client";
import { exchangeCodeForToken, readOAuthConfig } from "@/lib/github/oauth";
import { upsertCredential } from "@/lib/github/repo";
import { encryptCredential } from "@/lib/security/credentials";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectTo(req: NextRequest, params: Record<string, string>): Response {
  // Honour the optional `lazyos_gh_return_to` cookie set by /init when the
  // caller (e.g. the OSS-onboarding wizard) wants to land back somewhere
  // other than /settings/github after the OAuth round-trip.
  const returnTo = req.cookies.get("lazyos_gh_return_to")?.value;
  const targetPath =
    returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
      ? returnTo
      : "/settings/github";

  const url = new URL(targetPath, req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = NextResponse.redirect(url.toString(), { status: 302 });
  // Clear both helper cookies regardless of outcome.
  res.cookies.set("lazyos_gh_state", "", {
    path: "/api/auth/github",
    maxAge: 0,
  });
  res.cookies.set("lazyos_gh_return_to", "", {
    path: "/api/auth/github",
    maxAge: 0,
  });
  return res;
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return redirectTo(req, { error: "auth-required" });
  }

  const config = readOAuthConfig();
  if (!config) {
    return redirectTo(req, { error: "oauth_not_configured" });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const ghError = req.nextUrl.searchParams.get("error");
  if (ghError) {
    return redirectTo(req, { error: `gh_${ghError}` });
  }
  if (!code || !state) {
    return redirectTo(req, { error: "missing_code_or_state" });
  }

  const cookieState = req.cookies.get("lazyos_gh_state")?.value;
  if (!cookieState || cookieState !== state) {
    return redirectTo(req, { error: "state_mismatch" });
  }

  let exchanged;
  try {
    exchanged = await exchangeCodeForToken(config, code);
  } catch (err) {
    return redirectTo(req, {
      error: "exchange_failed",
      message: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

  let user;
  try {
    user = await validateToken(exchanged.accessToken);
  } catch (err) {
    return redirectTo(req, {
      error: "validate_failed",
      message: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

  let encryptedToken: string;
  let encryptedRefresh: string | null = null;
  try {
    encryptedToken = encryptCredential(exchanged.accessToken);
    if (exchanged.refreshToken) {
      encryptedRefresh = encryptCredential(exchanged.refreshToken);
    }
  } catch (err) {
    return redirectTo(req, {
      error: "encrypt_failed",
      message: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

  try {
    upsertCredential({
      userId,
      authKind: "oauth",
      encryptedToken,
      githubLogin: user.login,
      githubUserId: user.id,
      avatarUrl: user.avatarUrl,
      encryptedRefresh,
      scope: exchanged.scope,
      expiresAt: exchanged.expiresAt,
    });
  } catch (err) {
    return redirectTo(req, {
      error: "store_failed",
      message: err instanceof Error ? err.message.slice(0, 120) : "unknown",
    });
  }

  return redirectTo(req, { connected: "1", login: user.login });
}
