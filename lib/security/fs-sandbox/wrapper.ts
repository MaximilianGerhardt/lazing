/**
 * FS-Sandbox — Spawn-Wrapper (Slice FS-3).
 *
 * wrapWithSandbox() attaches the sandbox wrapper to an innerCmd:
 *   `sandbox-exec -f <profile.sb> bash -c '<innerCmd>'`
 * and takes care of writing + cleaning up the temp profile.
 *
 * The default posture is ENFORCE — a security restriction is NOT
 * default-off (owner decision). LAZYOS_FS_SANDBOX=off is a pure
 * debug escape hatch.
 *
 * Integration: in server/agents/tmux-spawn.ts this wrapper is placed around the
 * `innerCmd` block (:301-306), BEFORE it is wrapped into the env allowlist.
 * See the integrator note at the end of the slice.
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { FsSandboxSpec, SandboxMode, SandboxWrap } from './types';
import { renderSeatbeltProfile } from './macos';

/**
 * Local shellQuote helper. Identical to the one in server/agents/tmux-spawn.ts:108
 * — deliberately duplicated so this module stays I/O-light and independently
 * testable without a server import.
 *
 * integrator: replace with a shared shellQuote once a shared helper
 *             exists (currently it is defined locally in tmux-spawn.ts).
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Determines the sandbox posture from the environment.
 * 'off' ONLY if LAZYOS_FS_SANDBOX==='off' (case-sensitive, exact). Any other
 * value — incl. 'on', undefined, empty, 'ENFORCE' — yields 'enforce'.
 * Default = enforce.
 */
export function resolveSandboxMode(env?: NodeJS.ProcessEnv): SandboxMode {
  const e = env ?? process.env;
  return e.LAZYOS_FS_SANDBOX === 'off' ? 'off' : 'enforce';
}

const NOOP = (): void => {
  /* nothing to clean up */
};

/**
 * Wraps an innerCmd into the sandbox wrapper.
 *
 * mode 'off'      → { command: innerCmd, profilePath: null, cleanup: noop }
 *                   + console.warn (sandbox is off).
 * mode 'enforce'  → writes the rendered seatbelt profile to
 *                   <tmpDir>/lazyos-sb-<rand>.sb, and
 *                   command = `sandbox-exec -f <profilePath> bash -c <quoted innerCmd>`.
 *                   cleanup() deletes the temp profile.
 *
 * @param innerCmd The command to run sandboxed (e.g. `cd <wt> && claude …`).
 * @param spec     The platform-neutral sandbox spec (from buildSandboxSpec).
 * @param opts.mode    Posture override; default via resolveSandboxMode().
 * @param opts.tmpDir  Directory for the temp profile; default os.tmpdir().
 */
export function wrapWithSandbox(
  innerCmd: string,
  spec: FsSandboxSpec,
  opts?: { mode?: SandboxMode; tmpDir?: string },
): SandboxWrap {
  const mode = opts?.mode ?? resolveSandboxMode();

  if (mode === 'off') {
    // Debug escape hatch. Warn loudly + visibly — nobody should accidentally
    // run in production with the FS sandbox switched off.
    console.warn(
      '[fs-sandbox] WARNUNG: LAZYOS_FS_SANDBOX=off — FS-Sandbox ist DEAKTIVIERT. ' +
        'Der Spawn kann beliebige absolute Pfade lesen (Live-DB, Secrets, andere Projekte). ' +
        'Nur für Debugging. Default ist enforce.',
    );
    return { command: innerCmd, profilePath: null, cleanup: NOOP };
  }

  // --- enforce: render the profile + write it to its own temp file -------
  const profileText = renderSeatbeltProfile(spec);

  // Own exclusive temp directory per spawn (avoids collisions +
  // allows clean recursive deletion). Falls back to os.tmpdir().
  const baseTmp = opts?.tmpDir ?? tmpdir();
  const dir = mkdtempSync(join(baseTmp, 'lazyos-sb-'));
  const rand = randomBytes(6).toString('hex');
  const profilePath = join(dir, `lazyos-sb-${rand}.sb`);

  // Restrictive permissions: owner read/write only (0600). The profile
  // itself is not a secret, but defense-in-depth.
  writeFileSync(profilePath, profileText, { mode: 0o600 });

  // sandbox-exec -f <profile> bash -c '<innerCmd>'
  // innerCmd is shell-quoted so no token split / no injection
  // is possible. The whole construct is wrapped again by the caller (tmux-spawn)
  // into the env wrapper — the quotings nest cleanly.
  const command = `sandbox-exec -f ${shellQuote(profilePath)} bash -c ${shellQuote(innerCmd)}`;

  const cleanup = (): void => {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup; an orphaned temp profile is harmless (0600,
      // no secret) and is collected by the OS temp GC.
    }
  };

  return { command, profilePath, cleanup };
}
