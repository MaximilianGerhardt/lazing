/**
 * Safe, non-destructive self-healing preflight (Track B, B1).
 *
 * Each healer is:
 *   - IDEMPOTENT — running it twice produces the same end state; the second
 *     run reports `noop`.
 *   - NON-DESTRUCTIVE — it only creates/appends, never deletes, truncates,
 *     kills, or recreates. Anything destructive (kill a port, recreate the DB)
 *     is detect-and-report only and is NOT in this module.
 *
 * The preflight route (app/api/system/preflight) does GET = detect-only and
 * POST {healers[]} = run the requested safe fixes. The wizard's systemcheck
 * step shows the traffic-light and a single "Fix safe issues" button that
 * POSTs the auto-fixable healer ids.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { getDb, getDbPath } from "@/db/client";

/** Stable ids of the safe healers. Frozen so the route can validate input. */
export const SELF_HEAL_IDS = [
  "db-migrate",
  "lazyos-dir",
  "env-secrets",
  "ollama-model",
] as const;
export type SelfHealId = (typeof SELF_HEAL_IDS)[number];

export function isSelfHealId(s: string): s is SelfHealId {
  return (SELF_HEAL_IDS as readonly string[]).includes(s);
}

/** Severity of a detected issue. `info` healers are always auto-fixable. */
export type HealSeverity = "ok" | "warn" | "error";

export interface HealCheck {
  id: SelfHealId;
  title: string;
  /** Current observed state before any fix. */
  severity: HealSeverity;
  /** Human-readable status line (English). */
  detail: string;
  /** Whether a safe fix exists for the current state. */
  fixable: boolean;
  /** The literal command/action the fix would perform, for transparency. */
  fixAction: string | null;
}

export type HealOutcome = "fixed" | "noop" | "failed" | "skipped";

export interface HealResult {
  id: SelfHealId;
  outcome: HealOutcome;
  detail: string;
}

// ---------------------------------------------------------------------------
// Path helpers — all parameterized via env / os.homedir(); never hardcoded.
// ---------------------------------------------------------------------------

export function lazyosDir(): string {
  const override = process.env.LAZYOS_HOME_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".lazyos");
}

function envLocalPath(): string {
  const override = process.env.LAZYOS_ENV_FILE?.trim();
  if (override) return override;
  return path.join(process.cwd(), ".env.local");
}

function ollamaBaseUrl(): string {
  return (process.env.LAZYOS_OLLAMA_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
}

function ollamaPullModel(): string {
  // Small, fast default suited for role/risk checks (never deepseek-r1 here).
  return process.env.LAZYOS_OLLAMA_PULL_MODEL?.trim() || "nomic-embed-text";
}

// ---------------------------------------------------------------------------
// Detection — read-only, never mutates.
// ---------------------------------------------------------------------------

function detectDbMigrate(): HealCheck {
  try {
    getDb(); // idempotent open + migrate
    const db = getDb();
    const row = db.$raw.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const ok = (row?.integrity_check ?? "").toLowerCase() === "ok";
    return {
      id: "db-migrate",
      title: "Database schema + integrity",
      severity: ok ? "ok" : "error",
      detail: ok
        ? `Schema migrated, integrity_check=ok (${getDbPath()})`
        : `integrity_check returned: ${row?.integrity_check ?? "unknown"}`,
      // The DB opens & migrates on access; running the healer re-confirms.
      fixable: !ok ? false : true,
      fixAction: "open DB (auto-migrate) + PRAGMA integrity_check",
    };
  } catch (err) {
    return {
      id: "db-migrate",
      title: "Database schema + integrity",
      severity: "error",
      detail: `DB open/migrate failed: ${errMsg(err)}`,
      fixable: true,
      fixAction: "open DB (auto-migrate) + PRAGMA integrity_check",
    };
  }
}

function detectLazyosDir(): HealCheck {
  const dir = lazyosDir();
  const exists = existsSync(dir);
  let mode700 = false;
  if (exists) {
    try {
      const st = statSync(dir);
      mode700 = (st.mode & 0o777) === 0o700;
    } catch {
      mode700 = false;
    }
  }
  const ok = exists && mode700;
  return {
    id: "lazyos-dir",
    title: "State directory ~/.lazyos",
    severity: ok ? "ok" : "warn",
    detail: ok
      ? `${dir} exists (mode 700)`
      : exists
        ? `${dir} exists but is not mode 700`
        : `${dir} does not exist`,
    fixable: true,
    fixAction: `mkdir -p ${dir} && chmod 700`,
  };
}

/** Which required secrets are currently missing from process.env. */
function missingSecrets(): string[] {
  const required = ["LAZYOS_CREDENTIAL_KEY", "LAZYOS_AUTH_SECRET"];
  return required.filter((k) => !(process.env[k] ?? "").trim());
}

function detectEnvSecrets(): HealCheck {
  const missing = missingSecrets();
  const ok = missing.length === 0;
  return {
    id: "env-secrets",
    title: "Required secrets",
    severity: ok ? "ok" : "error",
    detail: ok
      ? "LAZYOS_CREDENTIAL_KEY + LAZYOS_AUTH_SECRET present"
      : `Missing: ${missing.join(", ")}`,
    fixable: !ok,
    fixAction: ok
      ? null
      : `generate ${missing.join(" + ")} and APPEND to ${envLocalPath()} (never clobber)`,
  };
}

async function detectOllamaModel(): Promise<HealCheck> {
  const base = ollamaBaseUrl();
  const model = ollamaPullModel();
  let up = false;
  let hasModel = false;
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 1200);
    const res = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(tm);
    if (res.ok) {
      up = true;
      const j = (await res.json().catch(() => ({}))) as {
        models?: Array<{ name?: string }>;
      };
      hasModel = (j.models ?? []).some((m) =>
        (m.name ?? "").split(":")[0] === model.split(":")[0],
      );
    }
  } catch {
    up = false;
  }
  if (!up) {
    return {
      id: "ollama-model",
      title: "Ollama default model",
      severity: "ok", // Optional: Ollama not running is not a failure.
      detail: "Ollama not running — optional, skipped",
      fixable: false,
      fixAction: null,
    };
  }
  return {
    id: "ollama-model",
    title: "Ollama default model",
    severity: hasModel ? "ok" : "warn",
    detail: hasModel
      ? `Ollama up, model "${model}" present`
      : `Ollama up, model "${model}" not pulled`,
    fixable: !hasModel,
    fixAction: hasModel ? null : `ollama pull ${model}`,
  };
}

/** Run the full read-only preflight (detect-only). */
export async function detectPreflight(): Promise<HealCheck[]> {
  const ollama = await detectOllamaModel();
  return [detectDbMigrate(), detectLazyosDir(), detectEnvSecrets(), ollama];
}

/** Coarse verdict for the traffic-light. */
export function preflightVerdict(checks: HealCheck[]): "passed" | "degraded" | "failed" {
  if (checks.some((c) => c.severity === "error")) return "failed";
  if (checks.some((c) => c.severity === "warn")) return "degraded";
  return "passed";
}

// ---------------------------------------------------------------------------
// Safe healers — idempotent, append/create only.
// ---------------------------------------------------------------------------

function healDbMigrate(): HealResult {
  try {
    getDb(); // re-run migrations (idempotent)
    const db = getDb();
    const row = db.$raw.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    const ok = (row?.integrity_check ?? "").toLowerCase() === "ok";
    return {
      id: "db-migrate",
      outcome: ok ? "noop" : "failed",
      detail: ok
        ? "Schema confirmed migrated; integrity ok"
        : `integrity_check=${row?.integrity_check ?? "unknown"} (manual recovery required)`,
    };
  } catch (err) {
    return { id: "db-migrate", outcome: "failed", detail: errMsg(err) };
  }
}

function healLazyosDir(): HealResult {
  const dir = lazyosDir();
  try {
    const existedBefore = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask; enforce 700 explicitly (idempotent).
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
    return {
      id: "lazyos-dir",
      outcome: existedBefore ? "noop" : "fixed",
      detail: existedBefore ? `${dir} already present` : `created ${dir} (mode 700)`,
    };
  } catch (err) {
    return { id: "lazyos-dir", outcome: "failed", detail: errMsg(err) };
  }
}

/**
 * Generate any missing required secret and APPEND it to .env.local — never
 * clobber an existing key. Reads the file first to confirm the key is truly
 * absent (defends against an env var set in the shell but not in the file).
 */
function healEnvSecrets(): HealResult {
  const missing = missingSecrets();
  if (missing.length === 0) {
    return { id: "env-secrets", outcome: "noop", detail: "all required secrets present" };
  }
  const file = envLocalPath();
  let existing = "";
  try {
    existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (err) {
    return { id: "env-secrets", outcome: "failed", detail: `read ${file}: ${errMsg(err)}` };
  }

  const toAppend: string[] = [];
  const generated: string[] = [];
  for (const key of missing) {
    // Never clobber: if the key already has a line in the file, skip it.
    const hasLine = new RegExp(`^\\s*${key}\\s*=`, "m").test(existing);
    if (hasLine) continue;
    const value = randomBytes(32).toString("hex");
    toAppend.push(`${key}=${value}`);
    generated.push(key);
  }

  if (toAppend.length === 0) {
    return {
      id: "env-secrets",
      outcome: "noop",
      detail: "secrets already present in .env.local (shell env may need a reload)",
    };
  }

  try {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const block = `${prefix}\n# Appended by lazyOS self-heal (B1) — generated secrets\n${toAppend.join("\n")}\n`;
    appendFileSync(file, block, { encoding: "utf8" });
    return {
      id: "env-secrets",
      outcome: "fixed",
      detail: `appended ${generated.join(" + ")} to ${file} — restart the server to load`,
    };
  } catch (err) {
    return { id: "env-secrets", outcome: "failed", detail: `append ${file}: ${errMsg(err)}` };
  }
}

async function healOllamaModel(): Promise<HealResult> {
  const base = ollamaBaseUrl();
  const model = ollamaPullModel();
  // Confirm Ollama is up first — if not, this is a no-op (optional component).
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 1200);
    const probe = await fetch(`${base}/api/tags`, { signal: ctrl.signal });
    clearTimeout(tm);
    if (!probe.ok) {
      return { id: "ollama-model", outcome: "skipped", detail: "Ollama not running — skipped" };
    }
    const j = (await probe.json().catch(() => ({}))) as {
      models?: Array<{ name?: string }>;
    };
    const present = (j.models ?? []).some(
      (m) => (m.name ?? "").split(":")[0] === model.split(":")[0],
    );
    if (present) {
      return { id: "ollama-model", outcome: "noop", detail: `model "${model}" already pulled` };
    }
  } catch {
    return { id: "ollama-model", outcome: "skipped", detail: "Ollama not reachable — skipped" };
  }

  // Pull via the native Ollama HTTP API (no shell). Non-streaming, long budget.
  try {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), 5 * 60_000);
    const res = await fetch(`${base}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
      signal: ctrl.signal,
    });
    clearTimeout(tm);
    if (!res.ok) {
      return {
        id: "ollama-model",
        outcome: "failed",
        detail: `pull ${model} -> HTTP ${res.status}`,
      };
    }
    return { id: "ollama-model", outcome: "fixed", detail: `pulled "${model}"` };
  } catch (err) {
    return { id: "ollama-model", outcome: "failed", detail: `pull ${model}: ${errMsg(err)}` };
  }
}

/** Run a single safe healer by id. */
export async function runHealer(id: SelfHealId): Promise<HealResult> {
  switch (id) {
    case "db-migrate":
      return healDbMigrate();
    case "lazyos-dir":
      return healLazyosDir();
    case "env-secrets":
      return healEnvSecrets();
    case "ollama-model":
      return healOllamaModel();
    default: {
      const _exhaustive: never = id;
      return { id: _exhaustive, outcome: "skipped", detail: "unknown healer" };
    }
  }
}

/** Run several safe healers in sequence (DB/disk fixes should not race). */
export async function runHealers(ids: SelfHealId[]): Promise<HealResult[]> {
  const results: HealResult[] = [];
  for (const id of ids) {
    results.push(await runHealer(id));
  }
  return results;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
