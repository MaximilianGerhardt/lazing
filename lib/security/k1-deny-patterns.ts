// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// K1 RAG Deny Patterns — SINGLE SOURCE OF TRUTH (P2-#8, 2026-05-25)
//
// Zero-dependency module. Intentionally has NO imports — it must be safe to
// import from both lib/ (via @/-alias) AND server/ (via relative path, no
// @/-alias available in server/tsconfig.json).
//
// AUTHORITY: lib-v1/mcp/tool-registry-filter.ts MCP_TOOL_DENY_LIST (superset).
//   That module contains the full deny-list including bare server-name entries
//   ('local-rag', '*-rag-server', '*-global-rag') that are evaluated against
//   McpTool.serverName by Schicht-1. This file exports only the
//   full-qualified `mcp__<server>__<tool>` patterns that are relevant for
//   canonical tool-name resolution in binding-resolver + tmux-spawn.
//
// CONSUMERS (must all agree — guarded by k1-drift.test.ts):
//   1. lib/routines/binding-resolver.ts  (imports via @/lib/security/k1-deny-patterns)
//   2. server/agents/tmux-spawn.ts       (imports via ../../lib/security/k1-deny-patterns)
//   3. lib-v1/mcp/tool-registry-filter.ts (re-exports as K1_MCP_QUALIFIED_DENY_PATTERNS)
//
// Drift-test: lib/routines/__tests__/k1-drift.test.ts asserts that
//   - K1_MCP_QUALIFIED_DENY_PATTERNS in tool-registry-filter re-exports
//     the exact same frozen array reference as this module.
//   - tmux-spawn.ts's K1_DISALLOWED_RAG_TOOLS equals this list (by value).
//
// SECURITY NOTE: NEVER replace this file with a mutable export. The
// Object.freeze() here is part of the K1 security contract (N2/POS-8).
// A test mock that strips the freeze will trigger the integrity guards in
// binding-resolver.ts and tool-registry-filter.ts.

/**
 * Frozen set of K1 RAG deny patterns in canonical `mcp__<server>__<tool>` form.
 *
 * These are GLOB patterns evaluated against canonical MCP tool names by
 * binding-resolver.ts (matchesK1Deny) and passed as --disallowedTools to the
 * claude-CLI in server/agents/tmux-spawn.ts.
 *
 * IMPORTANT: Do NOT add prefix-wildcards like `*-rag` — they can match
 * legitimate tools (e.g. `mcp__migrate-rag__*` would be a false positive).
 * Only full-prefix patterns with explicit server-name segments are allowed.
 */
export const K1_MCP_QUALIFIED_DENY_PATTERNS = Object.freeze([
  'mcp__local-rag__*',
  'mcp__standards-rag__*',
  'mcp__lazyos-rag__*',
  'mcp__*-global-rag__*',
] as const);

// Module-load-time integrity guard: ensures no test mock can silently hollow
// out K1 by replacing this module with an unfrozen array.
if (!Object.isFrozen(K1_MCP_QUALIFIED_DENY_PATTERNS)) {
  throw new Error(
    'SECURITY: K1_MCP_QUALIFIED_DENY_PATTERNS is not frozen. ' +
      'Likely vi.mock/jest.mock applied to lib/security/k1-deny-patterns. ' +
      'K1 hard-block (N2/POS-8) has been bypassed.',
  );
}

export type K1DenyPattern = typeof K1_MCP_QUALIFIED_DENY_PATTERNS[number];
