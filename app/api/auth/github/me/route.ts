/**
 * GET /api/auth/github/me — return the currently-linked GitHub identity.
 *
 * Response: { login, avatarUrl, authKind } or 404 if no credential bound.
 *
 * Used by the OSS-onboarding wizard to confirm an OAuth-return landed
 * a credential, so the wizard can advance the step automatically.
 */

import { type NextRequest, NextResponse } from "next/server";

import { findCredentialForUser } from "@/lib/github/repo";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const cred = findCredentialForUser(userId);
  if (!cred) {
    return NextResponse.json({ error: "not-connected" }, { status: 404 });
  }

  return NextResponse.json({
    login: cred.github_login,
    authKind: cred.auth_kind,
  });
}
