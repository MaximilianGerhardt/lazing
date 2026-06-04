/**
 * POST /api/github/connect — bind a GitHub Personal Access Token to the
 * current user.
 *
 * Flow:
 *   1. Read PAT from body { token: string }.
 *   2. Validate against GET /user (also enriches the row with
 *      login/id/avatar — saves a round-trip on first repo-list).
 *   3. Encrypt with LAZYOS_CREDENTIAL_KEY (re-use of credential
 *      encryption — same key, same format).
 *   4. Upsert into github_credentials.
 *   5. Return { connected: true, login, avatarUrl }.
 *
 * Errors:
 *   - 401 auth-required (no user cookie).
 *   - 400 invalid_token_format / invalid_json.
 *   - 401 github_token_invalid (GitHub returned 401/403).
 *   - 503 encrypt_failed (LAZYOS_CREDENTIAL_KEY not set).
 *
 * Note: OAuth-Connect lives at /api/auth/github/init + /callback.
 */

import { NextResponse, type NextRequest } from "next/server";

import { GitHubApiError, validateToken } from "@/lib/github/client";
import { upsertCredential } from "@/lib/github/repo";
import { encryptCredential } from "@/lib/security/credentials";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ConnectBody {
  token?: unknown;
}

// GitHub PATs:
//   - Classic: ghp_<36-base62>
//   - Fine-grained: github_pat_<22>_<59>
//   - OAuth (gh CLI): gho_<36-base62>
// We're lenient — anything 20-200 chars, then validateToken decides.
function looksLikeToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{20,255}$/.test(s);
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: ConnectBody;
  try {
    body = (await req.json()) as ConnectBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!looksLikeToken(token)) {
    return NextResponse.json(
      {
        error: "invalid_token_format",
        hint: 'Token muss 20-255 Zeichen sein. Beispiel "ghp_…" oder "github_pat_…".',
      },
      { status: 400 },
    );
  }

  // 1. Validate against GitHub
  let user;
  try {
    user = await validateToken(token);
  } catch (err) {
    if (err instanceof GitHubApiError && (err.status === 401 || err.status === 403)) {
      return NextResponse.json(
        {
          error: "github_token_invalid",
          message: err.githubMessage,
          status: err.status,
        },
        { status: 401 },
      );
    }
    return NextResponse.json(
      {
        error: "github_unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  // 2. Encrypt + 3. Upsert
  let encrypted: string;
  try {
    encrypted = encryptCredential(token);
  } catch (err) {
    return NextResponse.json(
      {
        error: "encrypt_failed",
        message: err instanceof Error ? err.message : String(err),
        hint: "LAZYOS_CREDENTIAL_KEY muss in der ENV gesetzt sein.",
      },
      { status: 503 },
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
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "store_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      connected: true,
      login: user.login,
      avatarUrl: user.avatarUrl,
      authKind: "pat",
    },
    { status: 201 },
  );
}
