/**
 * FS-Sandbox — Spec-Builder (Slice FS-3).
 *
 * buildSandboxSpec() takes the workspace path topology (worktree + roots +
 * bridge grants + home) and produces a pure, platform-neutral FsSandboxSpec.
 * NO I/O, no platform syntax — this is the deterministic middle between the
 * data model (workspace_fs_roots) and the platform renderer.
 *
 * Security-critical: the FIXED deny list is ALWAYS set, regardless of the
 * input. See docs/plans/2026-05-26_workspace-isolation-model.md §4.2.
 */

import type { FsAccess, FsSandboxSpec } from './types';

/** Default toolchain paths (read+exec). Phrased platform-independently,
 *  interpreted platform-specifically by the renderer. Deliberately broad enough for
 *  the real binaries (git, claude, codex, node, pnpm) and global tool stores. */
const DEFAULT_TOOLCHAIN_PATHS: readonly string[] = [
  '/usr/bin',
  '/bin',
  '/usr/lib',
  '/usr/local/bin',
  '/usr/local/lib',
  '/opt/homebrew/bin',
  '/opt/homebrew/lib',
  '/System/Library',
];

/** Normalizes a path defensively: trims, removes the trailing slash (except root),
 *  does not actively collapse `..` (the caller should avoid that with absolute paths —
 *  we rely on already-resolved absolute paths from the data model). */
function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (trimmed.length > 1 && trimmed.endsWith('/')) {
    return trimmed.replace(/\/+$/, '');
  }
  return trimmed;
}

/** Dedupe + drop empty, ordnungsstabil. */
function dedupe(paths: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const p = normalizePath(raw);
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function buildSandboxSpec(input: {
  /** rw, isolated — the worktree path. NEVER the live root. */
  worktreePath: string;
  /** further rw roots of the same workspace (FS-4). */
  extraRwRoots?: string[];
  /** ro roots of the workspace. */
  roRoots?: string[];
  /** <repoPath>/.git → MUST be allowed read-only, otherwise git ops in the
   *  worktree break (§4.2 „biggest break"). */
  liveGitDir?: string;
  /** FS-5: paths granted via bridge (ro or rw per grant type). */
  bridgeGrantedPaths?: { absPath: string; access: FsAccess }[];
  /** Home dir of the process user. */
  homeDir: string;
  /** Roots of OTHER workspaces — added to hardDeny (default-deny
   *  is not enough, since the uid could technically read them). */
  otherWorkspaceRoots?: string[];
}): FsSandboxSpec {
  const home = normalizePath(input.homeDir);
  if (!home) {
    // Defensive: without home we cannot compute the fixed deny list.
    // Fail-closed here means throwing — we throw instead of building a leaky
    // sandbox.
    throw new Error('[fs-sandbox] buildSandboxSpec: homeDir is required and must be a non-empty absolute path');
  }

  const bridgeGrants = input.bridgeGrantedPaths ?? [];

  // --- rw paths -----------------------------------------------------------
  // Worktree first (always rw), then extra rw roots, then rw bridge grants.
  const rwPaths = dedupe([
    input.worktreePath,
    ...(input.extraRwRoots ?? []),
    ...bridgeGrants.filter((g) => g.access === 'rw').map((g) => g.absPath),
  ]);

  // --- ro paths -----------------------------------------------------------
  // Workspace ro roots + live-.git (read-only!) + ro bridge grants +
  // ~/.claude (MAX-Plan OAuth session, tmux-spawn.ts:266-268). The OAuth path
  // MUST stay readable; the credentials file under it is cut out again via hardDeny
  // (last-match-wins in the renderer).
  const roPaths = dedupe([
    ...(input.roRoots ?? []),
    input.liveGitDir,
    `${home}/.claude`,
    ...bridgeGrants.filter((g) => g.access === 'ro').map((g) => g.absPath),
  ]);

  // --- FIXED deny list (§4.2) — ALWAYS set -------------------------------
  // These paths are hard-denied, even if the uid could read them.
  // ATTENTION re ordering: ~/.claude is listed above as a ro ALLOW; here
  // we deny ONLY the credentials variant under it. The renderer emits
  // hardDeny LAST (last-match-wins), so ~/.claude stays readable but
  // ~/.claude/credentials* is hard-blocked. This is the trickiest part
  // (§4.2 + owner question Q5) — implemented exactly this way.
  const hardDeny = dedupe([
    `${home}/.lazyos`, // live DB
    `${home}/.codex`,
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.config/gcloud`,
    // ~/.claude/credentials and every credentials* variant: as a path prefix.
    // The renderer appends a regex deny for exactly this entry, so
    // credentials, credentials.json, credentials.bak, … are all caught.
    `${home}/.claude/credentials`,
    // .env files (secrets) — the renderer emits a regex deny for this
    // on `\.env`, so .env, .env.local, .env.production, … are caught.
    // We encode the marker as a special sentinel that the renderer knows.
    ENV_SECRET_DENY_SENTINEL,
    // Roots of other workspaces.
    ...(input.otherWorkspaceRoots ?? []),
  ]);

  return {
    rwPaths,
    roPaths,
    homeDir: home,
    hardDeny,
    toolchainPaths: [...DEFAULT_TOOLCHAIN_PATHS],
    // Default true: FS hardening, not network (§4.2). claude/codex need network.
    allowNetwork: true,
  };
}

/**
 * Sentinel marker in hardDeny that signals the platform renderer to:
 * "emit a regex deny on all paths containing `.env`" — instead of
 * a literal subpath deny. That way .env, .env.local, .env.production
 * etc. are caught workspace-wide without enumerating every single path.
 *
 * Recognized by the renderer (macos.ts) and translated into `(deny file-read* (regex ...))`.
 * Other renderers (linux) translate analogously.
 */
export const ENV_SECRET_DENY_SENTINEL = '__LAZYOS_FS_DENY_ENV_SECRETS__';
