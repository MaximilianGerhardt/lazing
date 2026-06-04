/**
 * lib/workspaces/projects-root.ts
 *
 * Single source of truth for the default FS path of a workspace when the
 * `workspaces.path` column does NOT hold an explicit path.
 *
 * BACKGROUND: several call sites (lib/tickets/auto-dispatch.ts,
 * lib/workstreams/plan-executor.ts, server/agents/tier-orchestrator.ts) used
 * to hardcode a fixed projects root. That path does not exist on every host,
 * so any workspace without an explicit DB path failed in the plan-executor
 * with `INVALID_REPO_PATH` (assertIsGitRepo), fully blocking the website flow.
 *
 * Fix: the default is now configurable via `LAZYOS_PROJECTS_ROOT`.
 *   - ENV set → that value is used (trailing slashes normalized).
 *   - ENV unset → fall back to `<home>/lazyos-workspaces` (cross-platform).
 *
 * An explicit `workspaces.path` entry ALWAYS wins over this default — this
 * helper only acts as a fallback. N6: purely deterministic, no I/O.
 */

import os from "node:os";
import path from "node:path";

/** Default projects root (env-configurable, cross-platform fallback). */
export function projectsRoot(): string {
  const raw = process.env.LAZYOS_PROJECTS_ROOT?.trim();
  if (raw && raw.length > 0) {
    // Normalize trailing slashes so `${root}/${id}` does not produce double
    // slashes.
    return raw.replace(/\/+$/, "");
  }
  return path.join(os.homedir(), "lazyos-workspaces");
}

/**
 * Default FS path of a workspace (fallback when `workspaces.path` is empty).
 * `<projectsRoot>/<workspaceId>`.
 */
export function defaultWorkspacePath(workspaceId: string): string {
  return `${projectsRoot()}/${workspaceId}`;
}
