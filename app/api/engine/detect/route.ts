/**
 * GET /api/engine/detect — auto-detect available AI engines (Track B).
 *
 * Probes (best-effort, non-fatal — each engine isolated, 1500ms timeout):
 *   - claude-cli   → `claude --version` on $PATH
 *   - codex        → `codex --version` on $PATH
 *   - ollama       → HTTP GET http://127.0.0.1:11434/api/version
 *
 * Returns a list of all found engines + the "recommended" one (order =
 * priority: claude-cli > codex > ollama > none). The wizard shows the
 * recommendation as preselected but lets the user override manually.
 *
 * No code path blocks on any of these probes — all run in parallel with hard
 * timeouts so the wizard page never takes longer than ~2s to load.
 *
 * `?fresh=1` (B3 auto-verify): the binary probes are already re-run on every
 * call (spawn), but we also clear the engine-selector cache so the next
 * /api/system/health (which uses the cached selection) reflects a just-completed
 * `claude login` / `codex login` instead of a stale "not authenticated" snapshot.
 */

import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";

import { loadCurrentUser } from "@/lib/users/service";
import { clearEngineCache } from "@/lib/llm/engines/selector";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 1500;

interface EngineProbe {
  kind: "claude-cli" | "codex" | "ollama";
  found: boolean;
  location: string | null;
  versionHint: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const user = loadCurrentUser(req);
  if (!user) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  // B3 auto-verify: drop the cached selection so a freshly authenticated CLI
  // is reflected on the next health probe. The binary probes below are always
  // fresh regardless.
  if (req.nextUrl.searchParams.get("fresh") === "1") {
    clearEngineCache();
  }

  const [claude, codex, ollama] = await Promise.all([
    probeBinary("claude-cli", "claude"),
    probeBinary("codex", "codex"),
    probeOllama(),
  ]);

  const all: EngineProbe[] = [claude, codex, ollama];
  const found = all.filter((p) => p.found);
  const recommended = found.length > 0 ? found[0].kind : "none";

  return NextResponse.json({
    probes: all,
    recommended,
    detectedAt: new Date().toISOString(),
  });
}

async function probeBinary(
  kind: "claude-cli" | "codex",
  binary: string,
): Promise<EngineProbe> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (found: boolean, location: string | null, versionHint: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({ kind, found, location, versionHint });
    };

    try {
      const proc = spawn(binary, ["--version"], {
        timeout: PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      proc.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });
      proc.on("error", () => finish(false, null, null));
      proc.on("close", (code) => {
        const text = (stdout || stderr || "").trim().slice(0, 120);
        if (code === 0 && text.length > 0) {
          finish(true, binary, text);
        } else {
          finish(false, null, null);
        }
      });
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* noop */ }
        finish(false, null, null);
      }, PROBE_TIMEOUT_MS);
    } catch {
      finish(false, null, null);
    }
  });
}

async function probeOllama(): Promise<EngineProbe> {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch("http://127.0.0.1:11434/api/version", {
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { kind: "ollama", found: false, location: null, versionHint: null };
    }
    const j = (await res.json().catch(() => ({}))) as { version?: string };
    return {
      kind: "ollama",
      found: true,
      location: "http://127.0.0.1:11434",
      versionHint: j.version ? `ollama ${j.version}` : "ollama",
    };
  } catch {
    return { kind: "ollama", found: false, location: null, versionHint: null };
  } finally {
    clearTimeout(tm);
  }
}
