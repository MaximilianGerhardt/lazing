/**
 * POST /api/system/update — one-click self-update (localhost only).
 *
 * Spawns scripts/lazyos-update.sh detached: it backs up the DB, pulls the latest
 * code, reinstalls, runs forward-only migrations, rebuilds into a staging dir,
 * atomically swaps it in, and restarts the service (best-effort). The endpoint
 * returns immediately; the app may briefly restart, after which the version
 * indicator clears.
 *
 * Hard-gated:
 *   - session required (owner of the local instance),
 *   - LOOPBACK only — a rebuild+restart must never be triggerable over a tunnel
 *     or by a remote user. Dev note: under `pnpm dev` the restart step is
 *     best-effort (the script targets the systemd/launchd service install).
 */

import { spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import path from "node:path";

import { NextResponse, type NextRequest } from "next/server";

import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLoopback(req: NextRequest): boolean {
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  const proxied = Boolean(
    req.headers.get("x-forwarded-for") || req.headers.get("x-forwarded-host"),
  );
  return loopback && !proxied;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  if (!isLoopback(req)) {
    return NextResponse.json(
      {
        error: "local-only",
        hint: "Self-update can only be triggered from the local machine. Run scripts/lazyos-update.sh on the host.",
      },
      { status: 403 },
    );
  }

  const script = path.join(process.cwd(), "scripts", "lazyos-update.sh");
  if (!existsSync(script)) {
    return NextResponse.json({ error: "update-script-missing" }, { status: 500 });
  }

  const logPath = path.join("/tmp", "lazing-self-update.log");
  try {
    const out = openSync(logPath, "a");
    const child = spawn("bash", [script], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
  } catch (err) {
    return NextResponse.json(
      { error: "spawn-failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  writeAudit({
    actor: `user:${user.id}`,
    action: "system.self-update",
    targetUserId: user.id,
    payload: { logPath },
  });

  return NextResponse.json({
    started: true,
    logPath,
    note: "Updating in the background — the app may briefly rebuild and restart.",
  });
}
