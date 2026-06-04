/**
 * File-based structured logger — Production-Hardening Agent 5/8.
 *
 * Mirrors critical events to `~/.lazyos/logs/<YYYY-MM-DD>.jsonl` so an
 * operator can `tail -f` after the next.js dev-process has rotated or
 * the in-DB log table is corrupted. NDJSON one-line-per-event.
 *
 * Design constraints
 * ------------------
 *   - **Never throws.** Logging failures must not cascade.
 *   - **Append-only.** O_APPEND under the hood — no read-modify-write,
 *     safe under concurrent writers (single-instance Node still wins).
 *   - **Bounded.** Rotates per UTC day; we don't truncate, but warn
 *     once if today's file exceeds 64 MiB.
 *   - **No PII expansion.** The caller controls the payload — we do
 *     not auto-attach env, headers, cookies, or stack frames beyond
 *     what we were given.
 *   - **Node-runtime only.** Imports `node:fs` and `node:path`; Edge
 *     callers must not invoke this.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const LOG_ROOT =
  process.env.LAZYOS_LOG_DIR ?? path.join(os.homedir(), ".lazyos", "logs");
const SIZE_WARN_BYTES = 64 * 1024 * 1024;

let warnedOverSize = false;
let ensuredDirOnce = false;

function ensureDir(): void {
  if (ensuredDirOnce) return;
  try {
    fs.mkdirSync(LOG_ROOT, { recursive: true, mode: 0o700 });
    ensuredDirOnce = true;
  } catch {
    /* best-effort; subsequent appendFileSync will fail and be swallowed */
  }
}

function todayFile(): string {
  // YYYY-MM-DD (UTC). Stable across timezone changes.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return path.join(LOG_ROOT, `${y}-${m}-${d}.jsonl`);
}

export type LogLevel = "info" | "warn" | "error" | "fatal";

export interface LogRecord {
  level: LogLevel;
  scope: string;
  msg: string;
  // Optional structured fields. Caller-defined; we serialise as-is.
  extra?: Record<string, unknown>;
}

/**
 * Append a single structured record. Synchronous on purpose:
 *   - it's tiny (one short JSON line, fsync deferred to kernel),
 *   - it removes a class of "lost-on-crash" bugs that async would
 *     introduce when the process is shutting down,
 *   - the cost (<1ms typical) is dwarfed by request-handler work.
 *
 * Returns `true` on best-effort success, `false` if the write failed.
 */
export function logToFile(rec: LogRecord): boolean {
  ensureDir();
  const file = todayFile();
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      level: rec.level,
      scope: rec.scope,
      msg: rec.msg,
      ...(rec.extra ?? {}),
    }) + "\n";

  try {
    fs.appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    return false;
  }

  // One-time size warning — does NOT auto-rotate (operator decides).
  if (!warnedOverSize) {
    try {
      const st = fs.statSync(file);
      if (st.size > SIZE_WARN_BYTES) {
        warnedOverSize = true;
        process.stderr.write(
          `[lazyos.file-logger] WARN: ${file} > 64 MiB; consider rotation\n`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  return true;
}

/** Convenience helpers — same signature shape as `console.*`. */
export const flog = {
  info(scope: string, msg: string, extra?: Record<string, unknown>): void {
    logToFile({ level: "info", scope, msg, extra });
  },
  warn(scope: string, msg: string, extra?: Record<string, unknown>): void {
    logToFile({ level: "warn", scope, msg, extra });
  },
  error(scope: string, msg: string, extra?: Record<string, unknown>): void {
    logToFile({ level: "error", scope, msg, extra });
  },
  fatal(scope: string, msg: string, extra?: Record<string, unknown>): void {
    logToFile({ level: "fatal", scope, msg, extra });
  },
};

/** Read the path resolver — useful for /api/health to surface log location. */
export function logDir(): string {
  return LOG_ROOT;
}
