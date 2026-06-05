/**
 * /api/onboarding/main-folder — choose the main folder laz.ing operates in.
 *
 * GET  → { current, suggestion, exists } — the configured LAZYOS_PROJECTS_ROOT
 *        (if any) and the suggested default (~/Documents/lazing on a Mac).
 * POST {path} → expands `~`, creates the folder (mkdir -p), and UPSERTS
 *        LAZYOS_PROJECTS_ROOT in .env.local (so every new workspace is created
 *        under it). Sets process.env so it takes effect without a restart.
 *
 * This is the "where does laz.ing keep its work?" decision the onboarding asks
 * once. Full disk access for the folder is handled by the full-access step.
 * Session-gated.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { defaultProjectsRoot } from "@/lib/workspaces/projects-root";
import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function envFile(): string {
  const override = process.env.LAZYOS_ENV_FILE?.trim();
  return override && override.length > 0 ? override : path.join(process.cwd(), ".env.local");
}

/** Expand a leading `~` to the home directory; leave the rest untouched. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Upsert LAZYOS_PROJECTS_ROOT in .env.local (replace the line, else append). */
function upsertProjectsRoot(value: string): void {
  const file = envFile();
  const line = `LAZYOS_PROJECTS_ROOT=${value}`;
  let body = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^\s*#?\s*LAZYOS_PROJECTS_ROOT\s*=.*$/m.test(body)) {
    body = body.replace(/^\s*#?\s*LAZYOS_PROJECTS_ROOT\s*=.*$/m, line);
  } else {
    const prefix = body.length > 0 && !body.endsWith("\n") ? "\n" : "";
    body += `${prefix}\n# Main folder laz.ing operates in (onboarding)\n${line}\n`;
  }
  writeFileSync(file, body, "utf8");
  process.env.LAZYOS_PROJECTS_ROOT = value;
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!loadCurrentUser(req)) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  const current = (process.env.LAZYOS_PROJECTS_ROOT ?? "").trim() || null;
  const suggestion = defaultProjectsRoot();
  return NextResponse.json(
    { current, suggestion, exists: current ? existsSync(current) : false },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface PostBody {
  path?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    body = {};
  }

  const raw = typeof body.path === "string" ? body.path.trim() : "";
  const chosen = raw.length > 0 ? expandHome(raw) : defaultProjectsRoot();

  // Must be an absolute path; reject anything that doesn't resolve to one.
  const abs = path.resolve(chosen);
  if (!path.isAbsolute(abs)) {
    return NextResponse.json({ error: "invalid-path" }, { status: 400 });
  }

  try {
    mkdirSync(abs, { recursive: true });
  } catch (err) {
    return NextResponse.json(
      { error: "mkdir-failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  upsertProjectsRoot(abs);

  writeAudit({
    actor: `user:${user.id}`,
    action: "onboarding.main-folder",
    targetUserId: user.id,
    payload: { path: abs },
  });

  return NextResponse.json({ ok: true, path: abs });
}
