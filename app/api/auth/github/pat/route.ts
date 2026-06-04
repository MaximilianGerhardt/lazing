/**
 * POST /api/auth/github/pat — connect GitHub using a personal access token.
 *
 * Body: { token: string }
 *
 * Behaviour:
 *   1. 401 if no user.
 *   2. 400 if token missing or empty.
 *   3. Validate via GET /user.
 *   4. Encrypt and upsert into github_credentials with auth_kind='pat'.
 *   5. 200 { login, avatarUrl }.
 *
 * Used by the OSS-onboarding wizard's GitHub step fallback (when OAuth
 * isn't configured on the server, or when the user explicitly chooses
 * "Use a personal access token instead").
 */

import { type NextRequest, NextResponse } from "next/server";

import { validateToken } from "@/lib/github/client";
import { upsertCredential } from "@/lib/github/repo";
import { encryptCredential } from "@/lib/security/credentials";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: { token?: unknown };
  try {
    body = (await req.json()) as { token?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (token.length === 0) {
    return NextResponse.json({ error: "token-required" }, { status: 400 });
  }

  let user;
  try {
    user = await validateToken(token);
  } catch (err) {
    return NextResponse.json(
      {
        error: "validate-failed",
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      { status: 400 },
    );
  }

  let encrypted: string;
  try {
    encrypted = encryptCredential(token);
  } catch (err) {
    return NextResponse.json(
      {
        error: "encrypt-failed",
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      { status: 500 },
    );
  }

  try {
    upsertCredential({
      userId,
      authKind: "pat",
      encryptedToken: encrypted,
      githubLogin: user.login,
      githubUserId: user.id,
      avatarUrl: user.avatarUrl,
      encryptedRefresh: null,
      scope: null,
      expiresAt: null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "store-failed",
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    login: user.login,
    avatarUrl: user.avatarUrl,
  });
}
