// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M10 — K1-Defense Schicht-1 (Discovery layer)
// Authority: modules/M10/tool-registry-MODUL-SPEC.md
//
// Discovery layer for the MCP-tool filter. Enumerates tools exposed by configured
// MCP-servers (from .claude/settings.local.json) and provides a fail-closed,
// TTL-cached map of {serverName → McpTool[]} to the Schicht-1 filter.
//
// N2: discovery never silently passes through tools — fail-closed on any failure
//     (settings missing/corrupt, stdio timeout, child-process crash) → empty list.
// N8: discovery failures are observed via the EnumerationResult.errors[] surface;
//     the caller (tmux-spawn integration) is responsible for writing audit rows
//     and emitting Bridge-Push to notify the operator of disabled servers.
// N10: contentHash over canonical JSON of the result.

import { createHash } from 'node:crypto';

export interface McpTool {
  name: string; // canonical "mcp__<server>__<tool>"
  serverName: string;
  description?: string;
  inputSchema?: unknown;
}

export interface EnumerationError {
  serverName: string;
  error: string;
  timestamp: number;
}

export interface EnumerationResult {
  registry: Map<string, McpTool[]>;
  errors: EnumerationError[];
  enumeratedAt: number;
  contentHash: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface EnumerateOptions {
  /**
   * Override the path to `.claude/settings.local.json`. Defaults to
   * `<cwd>/.claude/settings.local.json`. Test-injectable.
   */
  settingsPath?: string;
  /**
   * Injected reader for the settings file. Defaults to fs.readFileSync.
   */
  readSettings?: (path: string) => string;
  /**
   * Injected stdio-discovery for a single MCP-server. Defaults to a real
   * MCP-JSON-RPC stdio discovery via child_process.spawn (Wave-1 stub —
   * the V1 milestone keeps this injectable so tests don't fork sub-processes).
   */
  discoverTools?: (
    serverName: string,
    cfg: McpServerConfig,
  ) => Promise<{ name: string; description?: string; inputSchema?: unknown }[]>;
  /**
   * Override `Date.now()` for deterministic tests.
   */
  now?: () => number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const INIT_TIMEOUT_MS = 3000;
const LIST_TIMEOUT_MS = 5000;

const _cache: Map<string, EnumerationResult> = new Map();

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + (value as unknown[]).map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function cacheKeyFor(serverNames: string[]): string {
  return sha256Hex(JSON.stringify([...serverNames].sort()));
}

function serializeRegistry(registry: Map<string, McpTool[]>): Record<string, McpTool[]> {
  const out: Record<string, McpTool[]> = {};
  for (const [k, v] of registry) {
    out[k] = v.map((t) => ({
      name: t.name,
      serverName: t.serverName,
      description: t.description,
    }));
  }
  return out;
}

function defaultReadSettings(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return fs.readFileSync(path, 'utf8');
}

function defaultDiscoverTools(
  _serverName: string,
  _cfg: McpServerConfig,
): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
  // Real implementation forks `cfg.command cfg.args` via child_process.spawn and
  // issues MCP-JSON-RPC `initialize` + `tools/list`. For V1 we keep a fail-closed
  // stub: returns [] so the discovery layer reports zero tools rather than
  // attempting to spawn arbitrary binaries from settings.local.json during
  // unit-test runs. Production caller injects a real implementation.
  return Promise.resolve([]);
}

/**
 * Enumerate exposed MCP-tools for the requested server-names.
 *
 * Fail-closed: never throws. On any failure (settings missing/corrupt,
 * server-not-in-settings, child-process error, stdio timeout) the affected
 * server gets an empty tool-list + an entry in `errors[]`.
 *
 * TTL-cached for 5 minutes (CACHE_TTL_MS). Cache-key is sha256 over sorted
 * serverNames — order-insensitive.
 */
export async function enumerateMcpTools(
  serverNames: string[],
  opts: EnumerateOptions = {},
): Promise<EnumerationResult> {
  const now = opts.now ?? Date.now;
  const key = cacheKeyFor(serverNames);
  const cached = _cache.get(key);
  if (cached && now() - cached.enumeratedAt < CACHE_TTL_MS) {
    return cached;
  }

  const registry = new Map<string, McpTool[]>();
  const errors: EnumerationError[] = [];

  // Step 1: read settings.local.json
  const settingsPath = opts.settingsPath ?? `.claude/settings.local.json`;
  let mcpServers: Record<string, McpServerConfig> = {};
  try {
    const reader = opts.readSettings ?? defaultReadSettings;
    const raw = reader(settingsPath);
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    mcpServers = parsed.mcpServers ?? {};
  } catch (err) {
    // Hard failure → fail-closed: empty registry + error per requested server
    const message = `settings.local.json read failed: ${(err as Error).message}`;
    const ts = now();
    for (const s of serverNames) {
      registry.set(s, []);
      errors.push({ serverName: s, error: message, timestamp: ts });
    }
    const result: EnumerationResult = {
      registry,
      errors,
      enumeratedAt: ts,
      contentHash: sha256Hex(
        canonicalJson({ kind: 'enum-fail-closed', err: message, serverNames }),
      ),
    };
    _cache.set(key, result);
    return result;
  }

  // Step 2: per requested server, discover tools.
  const discover = opts.discoverTools ?? defaultDiscoverTools;
  for (const serverName of serverNames) {
    const cfg = mcpServers[serverName];
    if (!cfg) {
      registry.set(serverName, []);
      errors.push({
        serverName,
        error: 'server-not-in-settings',
        timestamp: now(),
      });
      continue;
    }
    try {
      const rawTools = await discover(serverName, cfg);
      const tagged: McpTool[] = rawTools.map((t) => ({
        name: t.name.startsWith('mcp__') ? t.name : `mcp__${serverName}__${t.name}`,
        serverName,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      registry.set(serverName, tagged);
    } catch (err) {
      registry.set(serverName, []);
      errors.push({
        serverName,
        error: (err as Error).message ?? String(err),
        timestamp: now(),
      });
    }
  }

  const result: EnumerationResult = {
    registry,
    errors,
    enumeratedAt: now(),
    contentHash: sha256Hex(
      canonicalJson({
        registry: serializeRegistry(registry),
        errors,
        serverNames: [...serverNames].sort(),
      }),
    ),
  };
  _cache.set(key, result);
  return result;
}

/**
 * Reset the TTL cache. Used by tests and `lazyctl mcp refresh-tools`.
 */
export function clearToolRegistryCache(): void {
  _cache.clear();
}

export const __test_only = {
  CACHE_TTL_MS,
  INIT_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  canonicalJson,
  sha256Hex,
};
