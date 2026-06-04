/**
 * Heartbeat-Probes — Git-basierte Workspace-Gesundheits-Checks.
 *
 * Jede Probe laeuft als Child-Process gegen `path`. Alle Commands haben
 * ein hartes 5s-Timeout und werden parallel ausgefuehrt. Fehler einzelner
 * Probes werden gesammelt, blockieren aber nicht die Gesamt-Auswertung.
 *
 * Security:
 *   - Strict path allow-list (the configured projects root) — prevents
 *     command injection via a tampered workspace row.
 *   - NO shell interpolation: we use `execFile` (args array) instead of
 *     `exec` with interpolated strings.
 *
 * Performance:
 *   - Heavy Probes (outdated-deps, lint) werden im MVP ausgelassen —
 *     ein voller Sweep von 10 Workspaces muss unter 10s bleiben.
 *   - Phase 6 fuegt Snapshot-Caches hinzu (probes-ttl ~60s).
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { projectsRoot } from "@/lib/workspaces/projects-root";

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 5000;
// Allow-list prefix: the configured projects root with a trailing separator.
const PROJECTS_ROOT = projectsRoot() + path.sep;

export interface ProbeResult {
  /** Unix timestamp (ms) of the last HEAD commit. */
  lastCommitTs?: number;
  /** Number of uncommitted changes (git status --porcelain). */
  uncommittedChanges?: number;
  /** Number of commits ahead of origin/main (fallback 0). */
  unpushedCommits?: number;
  /** Number of outdated npm deps — not filled in MVP (too slow). */
  outdatedDeps?: number;
  /** True when package.json exists at workspace root. */
  hasPackageJson: boolean;
  /** True when `.vercel/project.json` exists. */
  hasVercel: boolean;
  /** Collected probe errors — individual probes may fail without aborting. */
  error?: string;
}

/** Runs all probes in parallel for a single workspace. */
export async function probeWorkspace(
  workspaceId: string,
  workspacePath: string,
): Promise<ProbeResult> {
  // Path-traversal guard: workspaces MUST live under the projects root.
  // `private` is a synthetic workspace without filesystem — we short-circuit.
  if (workspaceId === "private") {
    return {
      hasPackageJson: false,
      hasVercel: false,
    };
  }

  const normalized = path.resolve(workspacePath);
  if (!normalized.startsWith(PROJECTS_ROOT)) {
    return {
      hasPackageJson: false,
      hasVercel: false,
      error: `path_not_allowed:${workspacePath}`,
    };
  }

  // Fast-fail: if the dir does not exist at all, skip the git calls.
  const exists = await dirExists(normalized);
  if (!exists) {
    return {
      hasPackageJson: false,
      hasVercel: false,
      error: `path_missing:${workspacePath}`,
    };
  }

  const errors: string[] = [];

  // Helper that wraps a single probe and appends to `errors` on failure.
  const attempt = async <T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(
        `${name}:${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
      return undefined;
    }
  };

  const [
    lastCommitTs,
    uncommittedChanges,
    unpushedCommits,
    hasPackageJson,
    hasVercel,
  ] = await Promise.all([
    attempt("last_commit", () => probeLastCommit(normalized)),
    attempt("uncommitted", () => probeUncommitted(normalized)),
    attempt("unpushed", () => probeUnpushed(normalized)),
    attempt("has_pkg_json", () => fileExists(path.join(normalized, "package.json"))),
    attempt("has_vercel", () =>
      fileExists(path.join(normalized, ".vercel", "project.json")),
    ),
  ]);

  // Deferred probes — only run when the cheaper signals indicate it's worth it.
  let outdatedDeps: number | undefined;
  if (hasPackageJson) {
    outdatedDeps = await attempt("outdated_deps", () =>
      probeOutdatedDeps(normalized, workspaceId),
    );
  }

  return {
    lastCommitTs,
    uncommittedChanges,
    unpushedCommits,
    outdatedDeps,
    hasPackageJson: hasPackageJson ?? false,
    hasVercel: hasVercel ?? false,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

// ---------------------------------------------------------------------------
// Individual probes
// ---------------------------------------------------------------------------

async function probeLastCommit(cwd: string): Promise<number | undefined> {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-1", "--format=%ct"],
    { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds)) return undefined;
  return seconds * 1000;
}

async function probeUncommitted(cwd: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
    cwd,
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024, // 1MB — very large repos could overflow default 256k
  });
  if (!stdout) return 0;
  return stdout.split("\n").filter((line) => line.length > 0).length;
}

/**
 * Count commits ahead of origin/main. If origin/main doesn't exist
 * (fresh repo, different default branch), we return 0 quietly.
 */
async function probeUnpushed(cwd: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--count", "HEAD", "^origin/main"],
      { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    );
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // origin/main may not exist — try origin/master as fallback.
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-list", "--count", "HEAD", "^origin/master"],
        { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      );
      const n = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
}

/**
 * `pnpm outdated` kann bei grossen Workspaces Sekunden brauchen und haengt
 * am Netz. Wir ertragen das nicht live pro Sweep — stattdessen:
 *   - Hartes 4s-Timeout (unter dem 5s-Probe-Budget).
 *   - Cache pro Workspace mit 30min-TTL. Fallback bei Timeout = letzter Wert.
 *   - Failure ist "weich": undefined statt throw (UI zeigt dann einfach "—").
 */
const OUTDATED_CACHE = new Map<string, { value: number; ts: number }>();
const OUTDATED_TTL_MS = 30 * 60 * 1000; // 30min
const OUTDATED_TIMEOUT_MS = 4000;

async function probeOutdatedDeps(
  cwd: string,
  workspaceId: string,
): Promise<number | undefined> {
  // Warm cache first — skip the expensive call when we have a recent value.
  const cached = OUTDATED_CACHE.get(workspaceId);
  const now = Date.now();
  if (cached && now - cached.ts < OUTDATED_TTL_MS) {
    return cached.value;
  }

  try {
    const { stdout } = await execFileAsync("pnpm", ["outdated", "--format", "json"], {
      cwd,
      timeout: OUTDATED_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024, // 2MB
      // pnpm exits with non-zero when outdated deps are found — we still
      // want the JSON. execFile throws in that case, so we try/catch and
      // parse err.stdout.
    });
    const n = parseOutdatedJson(stdout);
    OUTDATED_CACHE.set(workspaceId, { value: n, ts: now });
    return n;
  } catch (err) {
    // Non-zero exit with populated stdout is the "found outdated" path.
    const anyErr = err as { stdout?: string; killed?: boolean; signal?: string };
    if (anyErr && typeof anyErr.stdout === "string" && anyErr.stdout.length > 0) {
      const n = parseOutdatedJson(anyErr.stdout);
      OUTDATED_CACHE.set(workspaceId, { value: n, ts: now });
      return n;
    }
    // Timeout or tool missing — keep prior cached value if any, else undefined.
    if (cached) return cached.value;
    return undefined;
  }
}

function parseOutdatedJson(stdout: string): number {
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === "{}") return 0;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>).length;
    }
    if (Array.isArray(parsed)) return parsed.length;
  } catch {
    // malformed — return 0 rather than throwing, UI just shows zero outdated.
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    await access(dirPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
