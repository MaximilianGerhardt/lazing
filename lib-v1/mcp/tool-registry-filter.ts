// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M10 — K1-Defense Schicht-1 (spawn-init hardcoded filter)
// Authority: modules/M10/tool-registry-filter-MODUL-SPEC.md (BUG-FIX-1 + BUG-FIX-2)
//
// Load-bearing code-gate that runs once at spawn-time (in tmux-spawn / scripts/mcp-bypass.ts
// for CLI bypass), BEFORE the claude-CLI sub-spawn ever sees the MCP-tool list.
//
// Pairs with M-RAG-06 Schicht-2 (runtime-tool-filter.ts) — the two share NOTHING
// except the DB-table `lazyos_mcp_bypass_state` (migration 0091) and the
// `__shared/{bypass-store,audit-writer}.ts` helpers.
//
// CLI-flag verification (BUG-FIX-1 — Critic-B T1):
//   - `--disallowedTools <tools...>` is the REAL flag (variadic). Verified via
//     `claude --help` on 2026-05-21.
//   - `--disable-mcp-tool` is an INVENTED flag — DO NOT use it. Caller MUST use
//     `--disallowedTools` (variadic, space-separated).
//
// Default-Strategy (BUG-FIX-2 M10.7-REOPEN): `subset` (constructive whitelist via
// `--strict-mcp-config` + `--mcp-config <filtered.json>`). `disallow` is opt-in
// after green smoke-test 3.
//
// N1: bypass.reason NEVER truncated.
// N2: hardcoded deny-list — no global RAG fallback ever.
// N5: TTL-limited N5-override path via `lazyos_mcp_bypass_state` (DB-table, not file).
// N8: every filter decision (allow/deny/bypassed) writes a row to `lazyos_mcp_filter_audit`.
// N10: contentHash via filterVersion (build-time sha256 over the frozen deny-list).

import type DatabaseT from 'better-sqlite3';
import { createHash } from 'node:crypto';
// P2-#8: shared zero-dep source of truth for K1 qualified patterns.
import { K1_MCP_QUALIFIED_DENY_PATTERNS as _K1_SHARED } from '../../lib/security/k1-deny-patterns';
import { getBypassedTools } from './__shared/bypass-store';
import { writeFilterAudit } from './__shared/audit-writer';

export interface McpTool {
  name: string;
  serverName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FilterResultEntry {
  tool: McpTool;
  reason: string;
  matchedPattern: string;
}

export interface FilterResult {
  allowed: McpTool[];
  denied: FilterResultEntry[];
  filterVersion: string;
}

/**
 * Hardcoded, frozen Deny-List. Q-S1-1 Decision: only suffix-wildcards allowed.
 * Prefix-wildcards (e.g. `*-rag`) would match legitimate tools — explicit entries
 * + suffix-wildcards only.
 */
export const MCP_TOOL_DENY_LIST = Object.freeze([
  // Exact server-name matches
  'local-rag',
  'standards-rag',
  'lazyos-rag',
  // Suffix-wildcards (match anything ending so)
  '*-rag-server',
  '*-global-rag',
  // Full-qualified MCP-tool-name wildcards (defensive)
  'mcp__local-rag__*',
  'mcp__standards-rag__*',
  'mcp__lazyos-rag__*',
  'mcp__*-global-rag__*',
] as const);

/**
 * Canonical K1 subset: only the full-qualified `mcp__<server>__<tool>` wildcard
 * patterns from MCP_TOOL_DENY_LIST.
 *
 * P2-#8: Re-exported from lib/security/k1-deny-patterns.ts (the zero-dep single
 * source of truth). Both binding-resolver.ts and server/agents/tmux-spawn.ts
 * import from that shared module. This re-export preserves the API surface of
 * tool-registry-filter.ts for any existing callers.
 *
 * Rationale for the subset: the resolver and spawn layers receive canonical
 * MCP tool names (`mcp__<server>__<tool>`). The bare server-name entries
 * ('local-rag', '*-rag-server', '*-global-rag') in MCP_TOOL_DENY_LIST are
 * handled by the Schicht-1 filter against the McpTool.serverName field and
 * never match canonical names — they are NOT duplicated here to avoid any
 * future false-positive risk if a legitimate MCP server has a name that
 * happens to suffix-match.
 */
export const K1_MCP_QUALIFIED_DENY_PATTERNS = _K1_SHARED;

// Expected length of MCP_TOOL_DENY_LIST. Must be updated whenever a new entry
// is added (or removed) to keep the integrity guard accurate.
const EXPECTED_DENY_LIST_LENGTH = 9;

// Defense 1: runtime-check that the list is frozen + non-trivial (catches
// vi.mock / jest.mock replacements).
if (!Object.isFrozen(MCP_TOOL_DENY_LIST)) {
  throw new Error(
    'SECURITY: MCP_TOOL_DENY_LIST is not frozen. Likely cause: vi.mock/jest.mock ' +
      'applied to tool-registry-filter. Bypass blocked. Refer M10 §6 Defense 1.',
  );
}
if (!Array.isArray(MCP_TOOL_DENY_LIST) || MCP_TOOL_DENY_LIST.length < EXPECTED_DENY_LIST_LENGTH) {
  throw new Error(
    `SECURITY: MCP_TOOL_DENY_LIST is malformed — expected ${EXPECTED_DENY_LIST_LENGTH} entries, ` +
      `got ${Array.isArray(MCP_TOOL_DENY_LIST) ? MCP_TOOL_DENY_LIST.length : 'non-array'}. ` +
      'Likely test-mock or accidental truncation. M10 §6 Defense 1.',
  );
}

// Defense 2: build-time filterVersion (N10)
export const FILTER_VERSION: string = createHash('sha256')
  .update(JSON.stringify([...MCP_TOOL_DENY_LIST]), 'utf8')
  .digest('hex');

interface PatternMatch {
  matched: boolean;
  matchedPattern: string;
}

function matchDenyPattern(tool: McpTool, pattern: string): PatternMatch {
  // Exact match: either tool.name or tool.serverName equals the pattern
  if (pattern === tool.name || pattern === tool.serverName) {
    return { matched: true, matchedPattern: pattern };
  }

  // Suffix-wildcard `*-rag-server`, `*-global-rag`
  if (pattern.startsWith('*-')) {
    const suffix = pattern.slice(1); // '-rag-server'
    if (tool.serverName.endsWith(suffix) || tool.name.endsWith(suffix)) {
      return { matched: true, matchedPattern: pattern };
    }
  }

  // Full-qualified wildcard `mcp__local-rag__*` or `mcp__*-global-rag__*`
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    if (prefix.includes('*')) {
      // Embedded wildcard, e.g. `mcp__*-global-rag__*`
      const parts = prefix.split('*');
      const head = parts[0] ?? '';
      const tail = parts.slice(1).join('*');
      if (tool.name.startsWith(head) && tool.name.includes(tail)) {
        return { matched: true, matchedPattern: pattern };
      }
    } else {
      if (tool.name.startsWith(prefix)) {
        return { matched: true, matchedPattern: pattern };
      }
    }
  }

  return { matched: false, matchedPattern: '' };
}

/**
 * Filter tools against the hardcoded deny-list. Pure function — does NOT touch
 * the DB nor write audit rows. Use `safeFilterMcpTools` for the fail-closed
 * wrapper + bypass-aware variant.
 */
export function filterMcpTools(serverName: string, tools: McpTool[]): FilterResult {
  const allowed: McpTool[] = [];
  const denied: FilterResultEntry[] = [];

  for (const tool of tools) {
    let denyHit: PatternMatch = { matched: false, matchedPattern: '' };
    for (const pattern of MCP_TOOL_DENY_LIST) {
      denyHit = matchDenyPattern(tool, pattern);
      if (denyHit.matched) break;
    }
    if (denyHit.matched) {
      denied.push({ tool, reason: 'deny-list-match', matchedPattern: denyHit.matchedPattern });
    } else {
      allowed.push(tool);
    }
  }

  return { allowed, denied, filterVersion: FILTER_VERSION };
}

export interface SafeFilterOptions {
  workspaceId?: string;
  /**
   * Optional DB handle for N5-bypass + audit. If omitted, bypass logic is
   * disabled and the filter behaves as `filterMcpTools` + fail-closed-on-throw.
   */
  db?: DatabaseT.Database;
}

/**
 * Fail-closed wrapper around `filterMcpTools`. Applies N5-bypass exemptions and
 * writes audit rows. On any internal exception → denies ALL tools.
 */
export function safeFilterMcpTools(
  serverName: string,
  tools: McpTool[],
  options: SafeFilterOptions = {},
): FilterResult {
  try {
    const raw = filterMcpTools(serverName, tools);

    // Apply N5-bypass (only if DB handle available — CLI bypass writes happen
    // before the spawn, so the DB must exist at this point in production).
    if (options.db && options.workspaceId) {
      const bypassed = getBypassedTools(options.db, serverName, options.workspaceId);
      if (bypassed.length > 0) {
        const stillDenied: FilterResultEntry[] = [];
        const movedToAllowed: McpTool[] = [];
        for (const entry of raw.denied) {
          if (
            bypassed.includes(entry.tool.name) ||
            bypassed.includes(entry.tool.serverName)
          ) {
            movedToAllowed.push(entry.tool);
            writeFilterAudit(options.db, {
              schicht: 's1',
              blockedAtSchicht: 'none',
              workspaceId: options.workspaceId,
              serverName,
              toolName: entry.tool.name,
              decision: 'bypassed',
              denialCode: 'n5-operator-override',
              matchedPattern: entry.matchedPattern,
              matchedLayer: 'glob',
              reason: 'N5-operator-override active bypass',
            });
          } else {
            stillDenied.push(entry);
          }
        }
        // Audit the denied rows
        for (const entry of stillDenied) {
          writeFilterAudit(options.db, {
            schicht: 's1',
            blockedAtSchicht: 's1',
            workspaceId: options.workspaceId,
            serverName,
            toolName: entry.tool.name,
            decision: 'denied',
            denialCode: 'deny-list-match',
            matchedPattern: entry.matchedPattern,
            matchedLayer: 'glob',
            reason: 'Schicht-1 hardcoded deny-list (M10 MCP_TOOL_DENY_LIST)',
          });
        }
        return {
          allowed: [...raw.allowed, ...movedToAllowed],
          denied: stillDenied,
          filterVersion: raw.filterVersion,
        };
      }
    }

    // No bypass DB available — straight filter. Still audit denials when DB exists.
    if (options.db) {
      for (const entry of raw.denied) {
        writeFilterAudit(options.db, {
          schicht: 's1',
          blockedAtSchicht: 's1',
          workspaceId: options.workspaceId ?? null,
          serverName,
          toolName: entry.tool.name,
          decision: 'denied',
          denialCode: 'deny-list-match',
          matchedPattern: entry.matchedPattern,
          matchedLayer: 'glob',
          reason: 'Schicht-1 hardcoded deny-list (M10 MCP_TOOL_DENY_LIST)',
        });
      }
    }
    return raw;
  } catch (err) {
    // Fail-closed: deny ALL tools on any internal exception
    const message = (err as Error)?.message ?? String(err);
    if (options.db) {
      try {
        writeFilterAudit(options.db, {
          schicht: 's1',
          blockedAtSchicht: 's1',
          workspaceId: options.workspaceId ?? null,
          serverName,
          toolName: '<all>',
          decision: 'denied',
          denialCode: 'filter-internal-failure',
          matchedPattern: '<exception>',
          matchedLayer: 'none',
          reason: `filter-internal-failure: ${message}`,
        });
      } catch {
        /* swallow — defense-in-depth */
      }
    }
    return {
      allowed: [],
      denied: tools.map((t) => ({
        tool: t,
        reason: 'filter-internal-failure',
        matchedPattern: '<exception>',
      })),
      filterVersion: 'failed',
    };
  }
}

/**
 * Compute the disallowed-tool-names list for the variadic `--disallowedTools`
 * flag of claude-cli. Returns the array of full canonical names (e.g.
 * `mcp__local-rag__query_documents`).
 */
export function computeDisallowedToolNames(
  enumeration: Map<string, McpTool[]>,
  options: SafeFilterOptions = {},
): { disallowedTools: string[]; serversToRemove: Set<string> } {
  const disallowed: string[] = [];
  const serversToRemove = new Set<string>();
  for (const [serverName, tools] of enumeration) {
    const filtered = safeFilterMcpTools(serverName, tools, options);
    for (const entry of filtered.denied) {
      disallowed.push(entry.tool.name);
    }
    if (
      tools.length > 0 &&
      filtered.denied.length === tools.length &&
      filtered.allowed.length === 0
    ) {
      serversToRemove.add(serverName);
    }
  }
  return { disallowedTools: disallowed, serversToRemove };
}

export const __test_only = {
  matchDenyPattern,
  FILTER_VERSION,
};
