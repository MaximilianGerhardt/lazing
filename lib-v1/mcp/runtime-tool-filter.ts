// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-RAG-06 — K1-Defense Schicht-2 (runtime tool-discovery + tool-call filter)
// Authority: modules/W2/M-RAG-06/TOOL-REGISTRY-FILTER-SPEC.md (BUG-FIX-1)
//
// Independent second code-path from M10 Schicht-1. Wraps the MCP-client between
// the sub-spawn and the MCP-server with two hooks:
//   1. callTool(name, args) — denies before forwarding if name matches a
//      Schicht-2 deny-rule.
//   2. listTools() — strips denied tools from the discovery response BEFORE
//      the sub-spawn ever sees them.
//
// Cache: 30s TTL — matches the spec name "30s-cached filter". Recompute on TTL
// expiry to avoid stampeding the spoof-detector for the same tool-name.
//
// Schicht-2 shares NOTHING with M10 except the DB-table `lazyos_mcp_bypass_state`
// (read via __shared/bypass-store.ts) and `lazyos_mcp_filter_audit` (write via
// __shared/audit-writer.ts).

import type DatabaseT from 'better-sqlite3';
import {
  checkSpoofAttempt,
  normalizeToolName,
  type SpoofCheckResult,
} from './runtime-spoof-detector';
import { lookupActiveBypass } from './__shared/bypass-store';
import { writeFilterAudit } from './__shared/audit-writer';

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<McpToolSchema[]>;
}

export interface FilterContext {
  db: DatabaseT.Database;
  workspaceId: string;
  operatorId: string;
  sessionId: string;
}

/**
 * Glob-patterns matched at the runtime layer. EXACT-prefix match only — no
 * substring-bleed. Spoofs are caught by the three-stage spoof-detector below.
 */
export const RUNTIME_DENY_GLOBS = Object.freeze([
  'mcp__local-rag__',
  'mcp__standards-rag__',
  'mcp__lazyos-rag__',
] as const);

const CACHE_TTL_MS = 30 * 1000; // 30s per M-RAG-06 spec

interface CacheEntry {
  decision: 'allowed' | 'denied' | 'bypassed';
  reason: string;
  matchedLayer: string;
  matchedPattern: string;
  expiresAt: number;
}

const _cache: Map<string, CacheEntry> = new Map();

function cacheKey(workspaceId: string, toolName: string): string {
  return `${workspaceId}::${toolName}`;
}

function deriveServerName(toolName: string): string {
  if (!toolName.startsWith('mcp__')) return 'unknown';
  const parts = toolName.slice(5).split('__');
  return parts[0] ?? 'unknown';
}

function matchesRuntimeGlob(toolName: string): { matched: boolean; prefix: string } {
  for (const prefix of RUNTIME_DENY_GLOBS) {
    if (toolName.startsWith(prefix)) {
      return { matched: true, prefix };
    }
  }
  return { matched: false, prefix: '' };
}

/**
 * Evaluate whether a tool-call should be allowed/denied/bypassed at Schicht-2.
 * Pure-ish — writes an audit-row + returns a decision. Cached for 30s per
 * (workspace, tool) pair to keep hot-path latency low.
 */
export function evaluateToolCall(
  toolName: string,
  ctx: FilterContext,
): 'allowed' | 'denied' | 'bypassed' {
  const now = Date.now();
  const key = cacheKey(ctx.workspaceId, toolName);
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.decision;
  }

  // STAGE 0 — normalize and detect normalization-tampering
  const norm = normalizeToolName(toolName);
  if (norm.changed) {
    writeFilterAudit(ctx.db, {
      schicht: 's2',
      blockedAtSchicht: 's2',
      workspaceId: ctx.workspaceId,
      serverName: deriveServerName(norm.normalized),
      toolName: norm.normalized,
      toolNameAttempted: toolName,
      decision: 'denied',
      denialCode: 'tool_name_normalization_changed',
      matchedPattern: 'normalize-pre-check',
      matchedLayer: 'string-validator',
      reason:
        'Schicht-2 normalize-pre-check: tool-name contained zero-width/BIDI/whitespace characters that were stripped during normalization — treated as spoof-attempt.',
    });
    _cache.set(key, {
      decision: 'denied',
      reason: 'tool_name_normalization_changed',
      matchedLayer: 'string-validator',
      matchedPattern: 'normalize-pre-check',
      expiresAt: now + CACHE_TTL_MS,
    });
    return 'denied';
  }

  const canonical = norm.normalized;

  // STAGE 1 — exact-prefix glob (fast path)
  const glob = matchesRuntimeGlob(canonical);
  let spoof: SpoofCheckResult | null = null;
  if (!glob.matched) {
    // STAGE 2 — three-stage spoof detector
    spoof = checkSpoofAttempt(canonical);
  }

  const denied = glob.matched || (spoof?.isSpoof ?? false);

  if (!denied) {
    _cache.set(key, {
      decision: 'allowed',
      reason: 'no-match',
      matchedLayer: 'none',
      matchedPattern: '',
      expiresAt: now + CACHE_TTL_MS,
    });
    return 'allowed';
  }

  // Check N5-bypass (active operator override)
  const serverName = deriveServerName(canonical);
  const bypass = lookupActiveBypass(ctx.db, {
    workspaceId: ctx.workspaceId,
    serverName,
    toolName: canonical,
  });
  if (bypass) {
    writeFilterAudit(ctx.db, {
      schicht: 's2',
      blockedAtSchicht: 'none',
      workspaceId: ctx.workspaceId,
      serverName,
      toolName: canonical,
      toolNameAttempted: toolName,
      decision: 'bypassed',
      denialCode: 'n5-operator-override',
      matchedPattern: glob.matched ? glob.prefix : spoof?.matchedPattern ?? '',
      matchedLayer: glob.matched ? 'glob' : (spoof?.matchedLayer as never) ?? 'none',
      bypassId: bypass.bypass_id,
      reason: `N5-operator-override active: ${bypass.reason}`,
    });
    _cache.set(key, {
      decision: 'bypassed',
      reason: 'n5-operator-override',
      matchedLayer: 'glob',
      matchedPattern: glob.matched ? glob.prefix : '',
      expiresAt: now + CACHE_TTL_MS,
    });
    return 'bypassed';
  }

  const denialCode = glob.matched
    ? 'runtime-glob-deny'
    : spoof?.decision ?? 'runtime-spoof-deny';
  writeFilterAudit(ctx.db, {
    schicht: 's2',
    blockedAtSchicht: 's2',
    workspaceId: ctx.workspaceId,
    serverName,
    toolName: canonical,
    toolNameAttempted: toolName,
    decision: 'denied',
    denialCode,
    matchedPattern: glob.matched ? glob.prefix : spoof?.matchedPattern ?? '',
    matchedLayer: glob.matched ? 'glob' : (spoof?.matchedLayer as never) ?? 'none',
    reason: glob.matched
      ? `Schicht-2 runtime-glob match: ${glob.prefix}`
      : `Schicht-2 spoof-detection: ${spoof?.decision} via ${spoof?.matchedLayer}`,
  });
  _cache.set(key, {
    decision: 'denied',
    reason: denialCode,
    matchedLayer: glob.matched ? 'glob' : spoof?.matchedLayer ?? 'none',
    matchedPattern: glob.matched ? glob.prefix : spoof?.matchedPattern ?? '',
    expiresAt: now + CACHE_TTL_MS,
  });
  return 'denied';
}

/**
 * Filter the discovery-response (list_tools / tools/list MCP-RPC) to remove all
 * tools that would be denied by Schicht-2. Cuts the attack-surface where a
 * sub-spawn would even *see* a forbidden tool name.
 */
export function filterDiscoveryResponse(
  tools: McpToolSchema[],
  ctx: FilterContext,
): McpToolSchema[] {
  const out: McpToolSchema[] = [];
  for (const t of tools) {
    const decision = evaluateToolCall(t.name, ctx);
    if (decision === 'allowed' || decision === 'bypassed') {
      out.push(t);
    }
  }
  return out;
}

/**
 * Register the Schicht-2 runtime filter on an MCP-client. Idempotent — calling
 * twice on the same client is a no-op (the second call returns without
 * re-wrapping).
 *
 * Throws SecurityError if the client appears to already have a different filter
 * installed (defense against plugin-code that hijacks the filter).
 */
const _registered = new WeakSet<object>();
const REGISTERED_BRAND = Symbol.for('lazyos.k1.schicht2.registered');

export class Schicht2SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Schicht2SecurityError';
  }
}

export function registerToolFilter(mcpClient: McpClient, ctx: FilterContext): void {
  if (_registered.has(mcpClient as unknown as object)) {
    return;
  }
  const branded = mcpClient as unknown as Record<symbol, unknown>;
  if (branded[REGISTERED_BRAND] !== undefined) {
    throw new Schicht2SecurityError(
      'mcpClient already has a different K1-Schicht-2 filter installed — refusing to double-wrap.',
    );
  }

  const originalCallTool = mcpClient.callTool.bind(mcpClient);
  const originalListTools = mcpClient.listTools.bind(mcpClient);

  mcpClient.callTool = async (name: string, args: Record<string, unknown>) => {
    const decision = evaluateToolCall(name, ctx);
    if (decision === 'denied') {
      throw new Schicht2SecurityError(
        `K1-Schicht-2 denied tool-call: ${name} (workspace=${ctx.workspaceId})`,
      );
    }
    return originalCallTool(name, args);
  };

  mcpClient.listTools = async () => {
    const tools = await originalListTools();
    return filterDiscoveryResponse(tools, ctx);
  };

  branded[REGISTERED_BRAND] = true;
  _registered.add(mcpClient as unknown as object);
}

/**
 * Reset internal cache. Used by tests + boot-recovery.
 */
export function clearSchicht2Cache(): void {
  _cache.clear();
}

export const __test_only = {
  cacheKey,
  deriveServerName,
  matchesRuntimeGlob,
  CACHE_TTL_MS,
};
