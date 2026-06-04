/**
 * FS-Sandbox — Barrel (Slice FS-3).
 *
 * Platform-abstracted FS-sandbox profile renderer for laz.ing.
 * Closes the gap: `env -i` (tmux-spawn.ts) scrubs ENV secrets, but does NOT
 * prevent an absolute file read. This sandbox confines a spawn FS-wise
 * to the isolated worktree (+ explicitly granted roots).
 *
 * Public surface:
 *   - types / contract        → types.ts
 *   - buildSandboxSpec()      → profile.ts (platform-neutral spec)
 *   - renderSeatbeltProfile() → macos.ts   (seatbelt .sb)
 *   - wrapWithSandbox() / resolveSandboxMode() → wrapper.ts (spawn wrapper)
 */

export type {
  FsAccess,
  FsRootGrant,
  FsSandboxSpec,
  SandboxMode,
  SandboxWrap,
} from './types';

export { buildSandboxSpec, ENV_SECRET_DENY_SENTINEL } from './profile';
export { renderSeatbeltProfile } from './macos';
export { wrapWithSandbox, resolveSandboxMode } from './wrapper';
