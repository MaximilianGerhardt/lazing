/**
 * FS-Sandbox — macOS seatbelt-Renderer (Slice FS-3).
 *
 * renderSeatbeltProfile(spec) produces a valid `.sb` profile (seatbelt /
 * sandbox-exec). Apple deprecated `sandbox-exec`, but on Darwin 25.x it is
 * still functional — it is the same seatbelt Apple uses internally
 * (§4.2). NO chroot/bindfs/macFUSE.
 *
 * SEATBELT SEMANTICS (load-bearing):
 *   - `(deny default)` sets deny-by-default.
 *   - Rules are evaluated in order, the LAST MATCHING one wins
 *     ("last match wins"). That is why the hard denies come AT THE END — they
 *     override any preceding allow rule.
 *   - This is exactly the trick for ~/.claude: first
 *     `(allow file-read* (subpath ~/.claude))` (OAuth readable),
 *     then `(deny file-read* (regex #"^~/.claude/credentials.*"))` (secret gone).
 *
 * Security-critical. Every path is escaped for seatbelt strings.
 */

import type { FsSandboxSpec } from './types';
import { ENV_SECRET_DENY_SENTINEL } from './profile';

/**
 * Escapes a path for a seatbelt string literal (literal/subpath).
 * Seatbelt strings are double-quoted; backslash and double-quote must be
 * escaped. We defensively escape both.
 */
function sbString(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escapes a path prefix for a seatbelt REGEX literal `#"..."`.
 * Regex metacharacters must be escaped so that e.g. `.` does not match „any
 * character". We anchor at the start (^) and allow arbitrary suffixes
 * via the pattern appended by the caller.
 */
function sbRegexLiteral(p: string): string {
  // First backslash/quote for the string literal, then escape regex meta.
  const escaped = p
    .replace(/\\/g, '\\\\') // backslash first
    .replace(/[.[\]{}()*+?^$|/]/g, '\\$&'); // regex meta
  return escaped;
}

/**
 * macOS firmlink/symlink roots: /tmp, /var, /etc really point to /private/...
 * Seatbelt matches `subpath` against the CANONICAL (resolved) path. An
 * allow/deny rule on "/var/x" therefore does NOT apply when the kernel resolves
 * the path to "/private/var/x". We defensively emit BOTH forms so that both
 * allow and (security-critical) deny rules match reliably.
 * Production worktrees under /Users/... are NOT affected (no symlink) —
 * this only hardens the case where a root lies under /tmp|/var|/etc.
 */
const MACOS_PRIVATE_SYMLINK_PREFIXES: ReadonlyArray<[string, string]> = [
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
  ['/etc', '/private/etc'],
];

/** Returns all form variants of a path that seatbelt should see:
 *  the path itself + possibly its /private-canonicalized form. */
function pathVariants(p: string): string[] {
  for (const [sym, real] of MACOS_PRIVATE_SYMLINK_PREFIXES) {
    if (p === sym || p.startsWith(sym + '/')) {
      const canonical = real + p.slice(sym.length);
      return canonical === p ? [p] : [p, canonical];
    }
    if (p === real || p.startsWith(real + '/')) {
      // Already canonical — also allow/deny the symlink form.
      const symForm = sym + p.slice(real.length);
      return symForm === p ? [p] : [p, symForm];
    }
  }
  return [p];
}

/**
 * Renders the complete seatbelt `.sb` profile from the platform-neutral spec.
 *
 * Order (mind last-match-wins):
 *   1. (version 1)
 *   2. (deny default)
 *   3. (allow process-fork process-exec)
 *   4. toolchain read+exec
 *   5. /tmp/lazyos-* rw (tmux-spawn writes there, :104-106)
 *   6. rw roots (worktree + extra) — read+write
 *   7. ro roots (workspace-ro + live-.git + ~/.claude + bridge-ro)
 *   8. network*, if allowNetwork
 *   9. HARD DENIES — LAST, override everything before them.
 */
export function renderSeatbeltProfile(spec: FsSandboxSpec): string {
  const lines: string[] = [];

  // --- Header --------------------------------------------------------------
  lines.push('(version 1)');
  lines.push(';; laz.ing FS-Sandbox — generiert pro Spawn (Slice FS-3).');
  lines.push(';; Default-deny; rw NUR auf isolierten Worktree; harte Denies zuletzt.');
  // bsd.sb is Apple's base profile (dyld-shared-cache, /System bootstrap,
  // sysctl/mach basics). WITHOUT this import, NO binary starts on Darwin 25.x
  // (dyld cannot read its closure → SIGABRT before main()). Empirically
  // verified: /usr/bin/true + git + node only boot with this import.
  // bsd.sb allows NO FS writes outside /dev|/tmp and no secret reads —
  // our explicit allow/deny rules below override it via last-match.
  lines.push('(import "bsd.sb")');
  lines.push('(deny default)');

  // --- Process control -----------------------------------------------------
  // claude/codex fork sub-processes (git, node, …) — without process-exec
  // every toolchain operation breaks.
  lines.push('(allow process-fork)');
  lines.push('(allow process-exec)');
  // sysctl/mach basics that almost every binary needs at startup. Without these
  // many tools crash before main(). Deliberately kept tight.
  lines.push('(allow sysctl-read)');
  lines.push('(allow mach-lookup)');

  // --- Toolchain (read + exec) --------------------------------------------
  if (spec.toolchainPaths.length > 0) {
    lines.push(';; Toolchain-Pfade (PATH-Binaries: git, claude, codex, node, pnpm).');
    for (const tc of spec.toolchainPaths) {
      for (const v of pathVariants(tc)) {
        lines.push(`(allow file-read* (subpath "${sbString(v)}"))`);
      }
    }
  }

  // --- Temp ----------------------------------------------------------------
  // tmux-spawn.ts writes prompt/system/log to /tmp/lazyos-* (:104-106).
  // We allow rw on the lazyos temp prefix (literal prefix via regex).
  lines.push(';; lazyOS-Temp (prompt/system/log-Dateien, tmux-spawn.ts:104-106).');
  lines.push(`(allow file-read* file-write* (regex #"^/tmp/lazyos-.*"))`);
  // Some tools need a readable /tmp + TMPDIR resolution; reading /tmp
  // is harmless (no secrets there), write stays limited to the prefix.
  lines.push('(allow file-read* (subpath "/tmp"))');
  lines.push('(allow file-read* (subpath "/private/tmp"))');

  // --- rw roots (worktree first) ------------------------------------------
  if (spec.rwPaths.length > 0) {
    lines.push(';; rw-Roots — der ISOLIERTE Worktree (+ ggf. weitere rw-Roots).');
    for (const rw of spec.rwPaths) {
      for (const v of pathVariants(rw)) {
        lines.push(`(allow file-read* file-write* (subpath "${sbString(v)}"))`);
      }
    }
  }

  // --- ro roots ------------------------------------------------------------
  if (spec.roPaths.length > 0) {
    lines.push(';; ro-Roots — Workspace-ro + Live-.git + ~/.claude (OAuth) + Bridge-ro.');
    for (const ro of spec.roPaths) {
      for (const v of pathVariants(ro)) {
        lines.push(`(allow file-read* (subpath "${sbString(v)}"))`);
      }
    }
  }

  // --- Network -------------------------------------------------------------
  // FS hardening, NOT network (§4.2). claude/codex need API calls.
  if (spec.allowNetwork) {
    lines.push(';; Netzwerk erlaubt — diese Sandbox härtet FS, nicht Netz.');
    lines.push('(allow network*)');
  }

  // --- HARD DENIES — LAST (last-match-wins overrides everything before) ----
  lines.push(';; ==== HARTE DENIES (last-match-wins; überstimmen jede allow-Regel oben) ====');
  for (const deny of spec.hardDeny) {
    if (deny === ENV_SECRET_DENY_SENTINEL) {
      // All paths containing `.env` — secrets. regex instead of subpath, so
      // .env, .env.local, .env.production, …/foo/.env are caught everywhere.
      lines.push(';; .env* (Secrets) — workspace-weit per regex.');
      lines.push(`(deny file-read* file-write* (regex #"\\.env"))`);
      continue;
    }
    if (deny.endsWith('/.claude/credentials')) {
      // Special case: ~/.claude stays ro-readable (OAuth session), BUT the
      // credentials file + every credentials* variant is hard-denied.
      // The regex anchors at the path + allows any suffix (.json/.bak/…).
      // This line MUST come AFTER the `(allow ... (subpath ~/.claude))` line
      // — it does, because hardDeny is emitted last.
      lines.push(';; ~/.claude bleibt ro-lesbar (OAuth), credentials* hart denyed (§4.2 Q5).');
      lines.push(`(deny file-read* file-write* (regex #"^${sbRegexLiteral(deny)}.*"))`);
      continue;
    }
    // Standard: hard subpath deny (live DB, ~/.codex, ~/.ssh, other workspaces).
    // Deny both symlink forms (security-critical: a deny on /var/x
    // must also block /private/var/x).
    for (const v of pathVariants(deny)) {
      lines.push(`(deny file-read* file-write* (subpath "${sbString(v)}"))`);
    }
  }

  // Trailing newline — some parsers are picky.
  return lines.join('\n') + '\n';
}
