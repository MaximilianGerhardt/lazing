/**
 * Phase MU.3 — Token routing per user.
 *
 * When a spawn (`workspace-session.ts`, `tmux-spawn.ts`, `tier-orchestrator.ts`)
 * runs for a specific user, it should use that user's own MAX-plan token
 * (if the user has an `own` binding) instead of the shared system token.
 *
 * Mechanics:
 *   - User sandbox HOME: `/tmp/lazyos-sandbox-<userId>`. Separate per user,
 *     created empty at boot.
 *   - In the sandbox HOME lies `~/.claude/.credentials.json` as a decrypted
 *     copy of the user's own credentials. We do NOT copy into the real
 *     `$HOME/.claude/` — the system token stays unaffected.
 *   - `prepareUserSandbox(userId)` creates the sandbox dir + decrypts
 *     the credentials. Returns `{ home }` for the child-process env.
 *
 * Important:
 *   - **Never** pass `ANTHROPIC_API_KEY` — that would dissolve the MAX plan.
 *   - On `claudeMaxStatus='shared'` we return `home: process.env.HOME` and
 *     the spawn uses the system token as today.
 *   - On `claudeMaxStatus='none'` the function throws explicitly — the spawn
 *     should then not run.
 *
 * This file is node-only (fs + crypto). Never import from client components.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { decryptCredential } from "@/lib/security/credentials";
import { getClaudeMaxBinding } from "@/lib/users/repo";

export interface UserSandbox {
  /** HOME path the child process should get. */
  home: string;
  /** Which mode is active — audit/log helper. */
  mode: "shared" | "own";
  /** Diagnostic: which email is bound (only when mode='own'). */
  email: string | null;
}

export class UserCredentialsError extends Error {
  constructor(
    message: string,
    public readonly code: "no-binding" | "denied" | "decrypt-failed",
  ) {
    super(message);
    this.name = "UserCredentialsError";
  }
}

const SANDBOX_ROOT =
  process.env.LAZYOS_USER_SANDBOX_ROOT?.trim() || "/tmp/lazyos-sandbox";

/**
 * Idempotent: creates the sandbox for the user, copies (decrypted)
 * `credentials.json` to `<sandbox>/.claude/.credentials.json`.
 *
 * Returns the sandbox HOME path.
 *
 * On `claudeMaxStatus='shared'`: returns the system HOME. On `'none'`:
 * throws `UserCredentialsError(code='denied')`.
 */
export function prepareUserSandbox(userId: string): UserSandbox {
  const binding = getClaudeMaxBinding(userId);
  if (!binding) {
    // User does not exist or has no entry — treat as shared.
    return {
      home: process.env.HOME ?? "/root",
      mode: "shared",
      email: null,
    };
  }

  if (binding.status === "none") {
    throw new UserCredentialsError(
      `User ${userId} hat Claude-MAX-Spawns explizit abgelehnt.`,
      "denied",
    );
  }

  if (binding.status === "shared" || !binding.credsPath) {
    return {
      home: process.env.HOME ?? "/root",
      mode: "shared",
      email: binding.email,
    };
  }

  // status === 'own' + credsPath set
  const sandboxHome = path.join(SANDBOX_ROOT, userId);
  const claudeDir = path.join(sandboxHome, ".claude");
  const targetFile = path.join(claudeDir, ".credentials.json");

  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });

  // Fetch + write the decrypted form (with 0600). On every call, so that
  // an update of the stored credentials takes effect immediately.
  if (!existsSync(binding.credsPath)) {
    throw new UserCredentialsError(
      `Encrypted credentials-file fehlt: ${binding.credsPath}`,
      "no-binding",
    );
  }
  let plaintext: string;
  try {
    const enc = readFileSync(binding.credsPath, "utf8");
    plaintext = decryptCredential(enc);
  } catch (err) {
    throw new UserCredentialsError(
      `Credentials-Decrypt fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      "decrypt-failed",
    );
  }
  writeFileSync(targetFile, plaintext, { encoding: "utf8", mode: 0o600 });

  return {
    home: sandboxHome,
    mode: "own",
    email: binding.email,
  };
}

/**
 * Convenience: returns the HOME for the spawn without throwing, falling back to
 * the system HOME. For spawns that must be robust (watchdog, cleanup crons).
 */
export function safeHomeForUser(userId: string | null | undefined): string {
  if (!userId) return process.env.HOME ?? "/root";
  try {
    return prepareUserSandbox(userId).home;
  } catch {
    return process.env.HOME ?? "/root";
  }
}
