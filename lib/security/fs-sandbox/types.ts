/**
 * FS-Sandbox — platform-abstracted file-system sandbox contract (Slice FS-3).
 *
 * Security-critical code. This contract is the ONLY source of truth
 * for the interface between:
 *   - the spec builder (profile.ts, builds the platform-neutral spec),
 *   - the platform renderer (macos.ts → seatbelt; later linux.ts → bwrap/landlock),
 *   - the spawn wrapper (wrapper.ts, attaches the sandbox wrapper to the innerCmd).
 *
 * Background (see docs/plans/2026-05-26_workspace-isolation-model.md §3 + §4.2):
 * `env -i` (tmux-spawn.ts) only scrubs ENV secrets, K1 locks MCP-RAG tools.
 * NEITHER prevents an ABSOLUTE file read. A free-rein Bash can read, via an
 * absolute path, ~/.lazyos/lazyos.db (live DB), .env.local (secrets) and other
 * sibling projects under the home dir. This sandbox closes exactly that gap on
 * the FS side (the network is deliberately NOT hardened — separate scope).
 *
 * Other modules build AGAINST this contract. Do NOT deviate.
 */

/** Access type for an FS root. */
export type FsAccess = 'ro' | 'rw';

/** A single granted FS root with absolute path and access type. */
export interface FsRootGrant {
  absPath: string;
  access: FsAccess;
}

/**
 * Platform-neutral sandbox specification. From this spec, every
 * platform renderer (seatbelt / bubblewrap / landlock) renders its concrete profile.
 * The spec itself contains NO platform-specific syntax.
 */
export interface FsSandboxSpec {
  /**
   * rw: the ISOLATED worktree path (NEVER the live root), plus possibly further
   * rw roots of the same workspace. The worktree is made writable,
   * never the live repo root.
   */
  rwPaths: string[];

  /**
   * ro: read-only roots of the workspace + live-.git (read) + possibly bridge-granted
   * paths. The live `.git` MUST land here, otherwise git ops in the worktree break
   * (§4.2 „biggest break": the worktree references .git via a file in the live root).
   */
  roPaths: string[];

  /**
   * Home dir of the process user. Needed for the MAX-auth read path (~/.claude OAuth,
   * tmux-spawn.ts:266-268) and for computing the fixed deny list.
   */
  homeDir: string;

  /**
   * Paths that are HARD-denied — even if the uid could technically read them.
   * On render, these are emitted LAST so they override any preceding
   * allow rule in seatbelt (last-match-wins).
   */
  hardDeny: string[];

  /**
   * Toolchain paths that must be allowed read+exec (PATH binaries: git, claude,
   * codex, pnpm, node, …). Without these the sub-agent cannot find its binaries.
   */
  toolchainPaths: string[];

  /**
   * Allow network? claude/codex need API calls. Default true — this
   * sandbox hardens FS, NOT network. Network isolation is a separate scope (§4.2).
   */
  allowNetwork: boolean;
}

/**
 * Sandbox posture.
 * - 'enforce': default. The sandbox wrapper is attached.
 * - 'off':     debug escape hatch (LAZYOS_FS_SANDBOX=off). Today's unsecured
 *              behavior + warning. A security restriction is NOT
 *              default-off (owner decision).
 */
export type SandboxMode = 'enforce' | 'off';

/**
 * Result of wrapWithSandbox(). `command` is the final shell command that
 * wraps the innerCmd into the sandbox wrapper (or at mode='off' the innerCmd itself).
 * `profilePath` points to the written temp profile (null at 'off').
 * `cleanup` deletes the temp profile (noop at 'off').
 */
export interface SandboxWrap {
  command: string;
  profilePath: string | null;
  cleanup: () => void;
}
