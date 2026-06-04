/**
 * POST /api/onboarding/install  — consented, streamed one-click install (B2)
 *
 * Body: { target: string, confirmShellInstaller?: boolean }
 *
 * The client sends ONLY an opaque target id (+ an explicit shell-confirm flag
 * for the Ollama installer). The id is resolved against the frozen
 * INSTALL_TARGETS allowlist (lib/onboarding/installers.ts). Unknown id => 400.
 * There is no string interpolation of client input into the command line —
 * the argv comes entirely from the allowlist.
 *
 * Response is an SSE stream (cloned from app/api/terminal/[workspaceId]):
 *   event: hello     { target, command }
 *   event: log       { line }           (stdout/stderr lines, streamed)
 *   event: progress  { phase }
 *   event: done      { ok, code }
 * plus ": hb\n\n" heartbeats every 15s, and abort-driven cleanup.
 *
 * On a successful install we clearEngineCache() so the next engine probe sees
 * the freshly installed CLI instead of a stale "not found" snapshot.
 */

import { NextResponse, type NextRequest } from "next/server";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { loadCurrentUser } from "@/lib/users/service";
import { writeAudit } from "@/lib/audit/write";
import { clearEngineCache } from "@/lib/llm/engines/selector";
import {
  resolveInstall,
  specCommandLine,
} from "@/lib/onboarding/installers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_INTERVAL_MS = 15_000;
const INSTALL_BUDGET_MS = 8 * 60_000; // hard cap so a hung installer cannot leak

interface PostBody {
  target?: string;
  confirmShellInstaller?: boolean;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }

  const targetId = typeof body.target === "string" ? body.target : "";
  const resolved = resolveInstall(targetId, {
    confirmShellInstaller: body.confirmShellInstaller === true,
  });

  if (!resolved.ok) {
    // Map allowlist resolution failures to clear 4xx codes.
    const status = resolved.code === "unknown-target" ? 400 : 422;
    return NextResponse.json({ error: resolved.code, target: targetId }, { status });
  }

  const { spec, target, platform } = resolved;
  const commandLine = specCommandLine(spec);

  writeAudit({
    actor: `user:${user.id}`,
    action: "onboarding.install.start",
    targetUserId: user.id,
    payload: { target: target.id, platform, command: commandLine },
  });

  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  // stdio: ["ignore","pipe","pipe"] => null stdin, readable stdout + stderr.
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let closed = false;

  const cleanup = (): void => {
    closed = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (budgetTimer) clearTimeout(budgetTimer);
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (eventName: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* controller closed — cleanup runs via cancel/abort */
        }
      };
      const sendHeartbeat = (): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          /* ignore */
        }
      };
      const finish = (ok: boolean, code: number | null): void => {
        if (closed) return;
        send("done", { ok, code });
        if (ok) {
          // Newly installed CLI should be visible to the next probe.
          clearEngineCache();
        }
        writeAudit({
          actor: `user:${user.id}`,
          action: ok ? "onboarding.install.done" : "onboarding.install.failed",
          targetUserId: user.id,
          payload: { target: target.id, code },
        });
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send("hello", { target: target.id, command: commandLine, platform });
      send("progress", { phase: "spawning" });

      // Buffer partial lines so we emit one `log` event per real line.
      let stdoutBuf = "";
      let stderrBuf = "";
      const pump = (chunk: string, which: "stdout" | "stderr"): void => {
        let buf = which === "stdout" ? stdoutBuf + chunk : stderrBuf + chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        if (which === "stdout") stdoutBuf = buf;
        else stderrBuf = buf;
        for (const line of parts) {
          send("log", { line, stream: which });
        }
      };

      try {
        child = spawn(spec.cmd, spec.args, {
          shell: spec.shell === true,
          stdio: ["ignore", "pipe", "pipe"],
          // No client input is forwarded to the environment.
          env: process.env,
        });
      } catch (err) {
        send("log", {
          line: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
          stream: "stderr",
        });
        finish(false, null);
        return;
      }

      send("progress", { phase: "running" });

      child.stdout.on("data", (b: Buffer) => pump(b.toString("utf8"), "stdout"));
      child.stderr.on("data", (b: Buffer) => pump(b.toString("utf8"), "stderr"));
      child.on("error", (err) => {
        send("log", { line: `error: ${err.message}`, stream: "stderr" });
        finish(false, null);
      });
      child.on("close", (code) => {
        // Flush any trailing partial lines.
        if (stdoutBuf.trim()) send("log", { line: stdoutBuf, stream: "stdout" });
        if (stderrBuf.trim()) send("log", { line: stderrBuf, stream: "stderr" });
        finish(code === 0, code ?? null);
      });

      heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      budgetTimer = setTimeout(() => {
        send("log", { line: `timed out after ${INSTALL_BUDGET_MS}ms`, stream: "stderr" });
        finish(false, null);
      }, INSTALL_BUDGET_MS);
    },
    cancel() {
      cleanup();
    },
  });

  req.signal.addEventListener("abort", cleanup);

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
