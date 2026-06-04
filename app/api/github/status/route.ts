/**
 * GET /api/github/status — returns the current GitHub connection status
 * for the logged-in user.
 *
 * Response:
 *   - { connected: false, oauthAvailable: bool }   — no credential row.
 *   - { connected: true, login, avatarUrl, authKind, lastValidatedAt }
 *
 * Used by:
 *   - /settings/github page (shows the "Connected as …" badge).
 *   - OSS-Onboarding step 4 (skip/continue logic).
 */

import { NextResponse, type NextRequest } from "next/server";

import { findCredentialForUser } from "@/lib/github/repo";
import { isOAuthConfigured } from "@/lib/github/oauth";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required" },
      { status: 401 },
    );
  }

  const oauthAvailable = isOAuthConfigured();
  const row = findCredentialForUser(userId);
  if (!row) {
    return NextResponse.json({
      connected: false,
      oauthAvailable,
    });
  }

  return NextResponse.json({
    connected: true,
    authKind: row.auth_kind,
    login: row.github_login,
    avatarUrl: row.avatar_url,
    githubUserId: row.github_user_id,
    scope: row.scope,
    expiresAt: row.expires_at,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
    oauthAvailable,
  });
}
