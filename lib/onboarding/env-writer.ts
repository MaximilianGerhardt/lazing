/**
 * Append-only .env.local writer (Track B, B3).
 *
 * Used by the engine "paste API key" path to persist OPENAI_API_KEY /
 * ANTHROPIC_API_KEY without ever clobbering an existing value. The rule is
 * strictly additive (N1-aligned):
 *
 *   - If the key already has a line in the file, we do NOT overwrite it and
 *     report `outcome: "exists"` (the operator must edit it by hand on purpose).
 *   - Otherwise we APPEND a new line and report `outcome: "appended"`.
 *
 * Only an allowlisted set of env keys may be written through here, so a bug or
 * a crafted request cannot inject arbitrary keys/values into the env file.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Env keys the onboarding flow is allowed to write. Frozen. */
export const WRITABLE_ENV_KEYS = Object.freeze([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const);
export type WritableEnvKey = (typeof WRITABLE_ENV_KEYS)[number];

export function isWritableEnvKey(s: string): s is WritableEnvKey {
  return (WRITABLE_ENV_KEYS as readonly string[]).includes(s);
}

export function envLocalPath(): string {
  const override = process.env.LAZYOS_ENV_FILE?.trim();
  if (override) return override;
  return path.join(process.cwd(), ".env.local");
}

/** True if `key` already has a definition line in the env file. */
function keyExistsInFile(contents: string, key: string): boolean {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(contents);
}

export type EnvWriteOutcome = "appended" | "exists";

export interface EnvWriteResult {
  key: WritableEnvKey;
  outcome: EnvWriteOutcome;
  file: string;
}

/**
 * Append `key=value` to .env.local if absent; never clobber.
 * `value` is written verbatim (no truncation — N1) but newlines are stripped
 * to keep the env file one-line-per-key well-formed.
 */
export function appendEnvVar(key: string, value: string): EnvWriteResult {
  if (!isWritableEnvKey(key)) {
    throw new Error(`refusing to write non-allowlisted env key: ${key}`);
  }
  const clean = value.replace(/[\r\n]+/g, "").trim();
  if (clean.length === 0) {
    throw new Error("refusing to write an empty value");
  }
  const file = envLocalPath();
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";

  if (keyExistsInFile(existing, key)) {
    // Make the new value visible to THIS process so the engine probe can use
    // it immediately, but do NOT rewrite the file (append-only contract).
    process.env[key] = clean;
    return { key, outcome: "exists", file };
  }

  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  const block = `${prefix}\n# Appended by lazyOS onboarding (B3)\n${key}=${clean}\n`;
  appendFileSync(file, block, { encoding: "utf8" });
  // Reflect into the live process env so the very next detect sees it.
  process.env[key] = clean;
  return { key, outcome: "appended", file };
}
