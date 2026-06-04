/**
 * lib/security/permission-tools.ts — Pure mode→tool resolver (A2, 2026-05-25).
 *
 * Single source of truth: given a workspace PermissionMode + a subagent role,
 * returns which tools the subagent is allowed to use AND which execution mode
 * the plan-executor must apply.
 *
 * Design principles:
 *   - Pure function: no DB, no I/O, no side-effects. N6 (deterministic).
 *   - Fail-closed default: unset / unknown mode → [] + 'plan-only' (heutiges sicheres Verhalten).
 *   - K1 hard-deny list is orthogonal — enforced by tmux-spawn, not here.
 *   - Bash only granted for freerein/freerein-with-audit (FreeRein) — never for lane/ask.
 *   - Write/Edit only for write-capable roles (architect, coder) in non-plan-only modes.
 *   - N1: this module MUST NOT be changed to widen the default case silently.
 *
 * Mode → tool matrix (canonical, used in tests + plan-executor):
 *
 *   Mode                 | Read Grep Glob | Write Edit | Bash | executionMode
 *   ---------------------|----------------|------------|------|-------------------
 *   freerein             | always         | arch/coder | yes  | execute-per-step
 *   freerein-with-audit  | always         | arch/coder | yes  | execute-per-step
 *   lane                 | always         | arch/coder | NO   | execute-per-step
 *   ask                  | -              | -          | NO   | plan-only
 *   unset / unknown      | -              | -          | NO   | plan-only  (DEFAULT)
 *
 * N8: callers are responsible for audit-logging the decision (DB write via
 *     lazyos_permission_audit). This function only computes the decision.
 */

import type { PermissionMode } from '../../lib-v1/permission/settings/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionModeResolved = 'plan-only' | 'execute-per-step';

export interface ToolResolution {
  /** Ordered list of tool names the subagent may use (never includes K1-denied tools). */
  readonly allowedTools: readonly string[];
  /** Execution mode the plan-executor must apply for this workspace + mode combo. */
  readonly executionMode: ExecutionModeResolved;
  /** The mode that was resolved (for audit annotation). */
  readonly resolvedMode: PermissionMode | 'unset';
}

// ---------------------------------------------------------------------------
// Role constants (mirrors execution-policy.ts WRITE_ALLOWED_ROLES)
// ---------------------------------------------------------------------------

/** Roles that may use Write/Edit tools. */
const WRITE_CAPABLE_ROLES = new Set(['architect', 'coder']);

/** Read-only tools always safe to include. */
const READONLY_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** Write tools conditionally granted for write-capable roles. */
const WRITE_TOOLS: readonly string[] = ['Write', 'Edit'];

/** Bash — only for FreeRein modes, never lane/ask/unset. */
const BASH_TOOL = 'Bash';

// ---------------------------------------------------------------------------
// Core resolver — pure function
// ---------------------------------------------------------------------------

/**
 * Resolve the allowed tools + execution mode for a given workspace mode and
 * subagent role.
 *
 * @param mode            The workspace permission mode from lazyos_permission_modes,
 *                        or undefined/null/'unset' if no mode is configured.
 * @param subagentRole    The role string of the spawned subagent (e.g. 'coder').
 *
 * @returns ToolResolution — never throws.
 *
 * Security invariant:
 *   resolveAllowedToolsForMode(undefined, '*') always returns plan-only + [].
 *   This is the DEFAULT SAFE BEHAVIOUR: identical to today's plan-executor
 *   when no workspace mode is set.
 */
export function resolveAllowedToolsForMode(
  mode: PermissionMode | null | undefined,
  subagentRole: string,
): ToolResolution {
  // Default / unset / unknown: fail-closed → plan-only, no tools.
  // This preserves the exact current behaviour when no mode has been chosen.
  if (!mode || !(['freerein', 'freerein-with-audit', 'lane', 'ask'] as string[]).includes(mode)) {
    return {
      allowedTools: [],
      executionMode: 'plan-only',
      resolvedMode: 'unset',
    };
  }

  const canWrite = WRITE_CAPABLE_ROLES.has(subagentRole);

  switch (mode) {
    // FreeRein: all tools, Bash included. Write only for write-capable roles.
    case 'freerein':
    case 'freerein-with-audit': {
      const tools: string[] = [...READONLY_TOOLS];
      if (canWrite) tools.push(...WRITE_TOOLS);
      tools.push(BASH_TOOL);
      return {
        allowedTools: Object.freeze(tools),
        executionMode: 'execute-per-step',
        resolvedMode: mode,
      };
    }

    // Lane: read-only + conditional write, NO Bash.
    case 'lane': {
      const tools: string[] = [...READONLY_TOOLS];
      if (canWrite) tools.push(...WRITE_TOOLS);
      return {
        allowedTools: Object.freeze(tools),
        executionMode: 'execute-per-step',
        resolvedMode: mode,
      };
    }

    // Ask: plan-only — no tools, user approves each action.
    case 'ask':
      return {
        allowedTools: Object.freeze([]),
        executionMode: 'plan-only',
        resolvedMode: mode,
      };
  }
}

// ---------------------------------------------------------------------------
// Workspace-mode DB reader — thin helper used by plan-executor.
// Kept here so plan-executor has a single import for both read + resolve.
// ---------------------------------------------------------------------------

/**
 * Reads the active PermissionMode for a workspace from lazyos_permission_modes.
 *
 * SECURITY (Security-Critic CRITICAL #1, 2026-05-25 — fail-open fix):
 *   This function reads ONLY a WORKSPACE-SPECIFIC row. It MUST NOT fall back to
 *   the `owner-default` row from migration 0098. A fallback would mean every
 *   workspace without an explicit mode resolves to a tool-granting mode — the
 *   exact opposite of "default safe / ask once".
 *
 *   Therefore:
 *     - workspace-specific row present + valid mode → that mode.
 *     - workspaceId === 'owner-default' sentinel → treated as NOT-granting
 *       (defensive; the bootstrap seed must never act as a per-workspace grant).
 *     - no workspace-specific row → return null → resolveAllowedToolsForMode(null)
 *       → plan-only (SAFE DEFAULT).
 *
 * Returns null (→ plan-only default) on any error, missing table, or if no
 * workspace-specific row exists. Callers must treat null as 'unset'.
 *
 * NOTE: does NOT throw. Fail-closed (null = plan-only).
 */
export function readWorkspacePermissionMode(
  db: import('better-sqlite3').Database,
  workspaceId: string,
): PermissionMode | null {
  const KNOWN: readonly string[] = ['freerein', 'freerein-with-audit', 'lane', 'ask'];

  // Defensive: the owner-default sentinel row is a bootstrap default, NOT a
  // per-workspace grant. Never resolve it to a tool-granting mode.
  if (workspaceId === 'owner-default') return null;

  try {
    const row = db
      .prepare(`SELECT mode FROM lazyos_permission_modes WHERE workspace_id = ? LIMIT 1`)
      .get(workspaceId) as { mode: string } | undefined;

    if (row?.mode && KNOWN.includes(row.mode)) {
      return row.mode as PermissionMode;
    }
    // NO owner-default fallback (CRITICAL #1): a workspace without an explicit
    // row stays unset → plan-only. The only way to grant tools is an explicit
    // user-set workspace-specific row (via the PATCH route).
  } catch {
    // Table may not exist yet or migration not applied — fail-closed.
  }
  return null;
}
