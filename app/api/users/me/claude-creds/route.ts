/**
 * Phase AU.3.5 — Claude MAX plan binding per user.
 *
 * GET    /api/users/me/claude-creds — returns status (binding info, no plaintext)
 * POST   /api/users/me/claude-creds { credentialsJson } — upload own credentials.json
 * DELETE /api/users/me/claude-creds — release binding, back to "shared"
 *
 * Storage: AES-256-GCM-encrypted to `<DATA_DIR>/user-creds/<userId>/credentials.json.enc`.
 * The plaintext never leaves the server — only the `oauthAccount.email` is
 * extracted on upload + stored as a diagnostic field.
 *
 * Auth: the user must be logged in (currentUserIdResolved → real ULID).
 */

import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { encryptCredential } from "@/lib/security/credentials";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { getClaudeMaxBinding, setClaudeMaxBinding } from "@/lib/users/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dataDir(): string {
  return (
    process.env.LAZYOS_USER_CREDS_DIR?.trim() ||
    path.join(process.env.HOME ?? "/root", ".lazyos", "user-creds")
  );
}

function userPath(userId: string): string {
  return path.join(dataDir(), userId, "credentials.json.enc");
}

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const binding = getClaudeMaxBinding(userId);
  if (!binding) {
    return NextResponse.json({ status: "shared", email: null });
  }
  return NextResponse.json({
    status: binding.status,
    email: binding.email,
    updatedAt: binding.updatedAt,
  });
}

interface PostBody {
  /** Contents of ~/.claude/.credentials.json as a string (the user copies it out). */
  credentialsJson?: string;
  /** "shared" as a default toggle without a file. */
  status?: "shared" | "own" | "none";
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  // Status-only toggle (shared/none without file upload)
  if (body.status === "shared" || body.status === "none") {
    setClaudeMaxBinding(userId, {
      status: body.status,
      credsPath: null,
      email: null,
    });
    // If a file was there before: delete it.
    const oldPath = userPath(userId);
    if (existsSync(oldPath)) {
      try {
        unlinkSync(oldPath);
      } catch {
        /* ignore */
      }
    }
    return NextResponse.json({ status: body.status });
  }

  if (!body.credentialsJson || body.credentialsJson.trim().length < 30) {
    return NextResponse.json(
      { error: "invalid-credentials", hint: "credentialsJson zu kurz/leer" },
      { status: 400 },
    );
  }

  // Minimal schema check: must be valid JSON and contain an oauthAccount.email
  // or at least an access_token.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.credentialsJson) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "invalid-json-content", hint: "credentialsJson ist kein JSON" },
      { status: 400 },
    );
  }

  // Email extraction (for diagnostics). Optional.
  let email: string | null = null;
  const oauth = parsed.oauthAccount as Record<string, unknown> | undefined;
  if (oauth && typeof oauth.email === "string") {
    email = oauth.email;
  } else if (typeof parsed.email === "string") {
    email = parsed.email;
  }

  // Encrypt + write to disk.
  const encrypted = encryptCredential(body.credentialsJson);
  const target = userPath(userId);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, encrypted, { encoding: "utf8", mode: 0o600 });

  setClaudeMaxBinding(userId, {
    status: "own",
    credsPath: target,
    email,
  });

  return NextResponse.json({
    status: "own",
    email,
  });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const target = userPath(userId);
  if (existsSync(target)) {
    try {
      unlinkSync(target);
    } catch {
      /* ignore */
    }
  }
  setClaudeMaxBinding(userId, {
    status: "shared",
    credsPath: null,
    email: null,
  });
  return NextResponse.json({ status: "shared" });
}
