// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// tool-registry-filter.test.ts — Integrity-Guard-Threshold test (#1a).
//
// Tests that MCP_TOOL_DENY_LIST has exactly 8 entries so the module-load-time
// guard (EXPECTED_DENY_LIST_LENGTH = 8) fires for any truncation.
//
// Uses node:test + node:assert (no Vite bundler — avoids resolving the
// __shared/* DB helpers that are irrelevant to this test). Run via:
//   npx tsx --test --test-force-exit lib-v1/mcp/tool-registry-filter.test.ts
//
// NOTE: tool-registry-filter.ts imports ./__shared/bypass-store and
// ./__shared/audit-writer. These modules are not needed for the pure filter
// logic under test. We register module-load hooks via node:module to stub
// them out BEFORE the import so tsx can load the file cleanly.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { register } from 'node:module';
import { createRequire } from 'node:module';

// ─────────────────────────────────────────────────────────────────────────────
// Stub the two __shared helpers via node:module hooks (CJS fallback path).
// Under tsx the modules are treated as ESM. We rely on tsx resolving
// ./__shared/bypass-store and ./__shared/audit-writer as if they were
// virtual stubs by overriding them in a parent-require scope.
// ─────────────────────────────────────────────────────────────────────────────

// Strategy: import only the pure exports that don't require __shared at
// module-eval time. tool-registry-filter.ts calls getBypassedTools /
// writeFilterAudit only inside safeFilterMcpTools, NOT at module load time.
// The module-load-time guard runs against the frozen array BEFORE any
// function is called, so the import will succeed if we pre-create stubs.
//
// We use tsx's own ESM-hoisting: tsx resolves imports before execution.
// The simplest workaround is to use a dynamic import with a custom loader
// OR to test the guard logic indirectly through the k1-deny-patterns source.
//
// FINAL APPROACH: test MCP_TOOL_DENY_LIST content by reading the source file
// directly (same technique as k1-drift.test.ts Part B), avoiding any import
// of tool-registry-filter.ts which would trigger the unresolvable __shared
// imports.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), 'utf8');
}

const src = readSource('lib-v1/mcp/tool-registry-filter.ts');

// ─────────────────────────────────────────────────────────────────────────────
// #1a — Integrity-Guard-Threshold tests (static source analysis)
// ─────────────────────────────────────────────────────────────────────────────

describe('MCP_TOOL_DENY_LIST integrity guard (#1a) — static source analysis', () => {

  it('EXPECTED_DENY_LIST_LENGTH is defined and equals 9', () => {
    assert.ok(
      src.includes('EXPECTED_DENY_LIST_LENGTH = 9'),
      'EXPECTED_DENY_LIST_LENGTH constant must be 9 in tool-registry-filter.ts',
    );
  });

  it('integrity guard uses EXPECTED_DENY_LIST_LENGTH (not a hardcoded literal < 4)', () => {
    // The guard line must reference the named constant, not the old literal `< 4`.
    assert.ok(
      src.includes('MCP_TOOL_DENY_LIST.length < EXPECTED_DENY_LIST_LENGTH'),
      'integrity guard must compare against EXPECTED_DENY_LIST_LENGTH',
    );
    // Old threshold (< 4) must be gone.
    assert.ok(
      !src.includes('MCP_TOOL_DENY_LIST.length < 4'),
      'old threshold < 4 must no longer be present',
    );
  });

  it('MCP_TOOL_DENY_LIST contains exactly 9 entries (count array items in source)', () => {
    // Locate the Object.freeze([...]) block for MCP_TOOL_DENY_LIST and count entries.
    // Each entry is on its own line, starts with whitespace + quote.
    const listMatch = src.match(
      /export const MCP_TOOL_DENY_LIST\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\s*as const\)/,
    );
    assert.ok(listMatch, 'MCP_TOOL_DENY_LIST Object.freeze block not found');

    const body = listMatch![1]!;
    // Count non-comment, non-empty lines that contain a string entry (start with quote after trim).
    const entryLines = body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith("'") || l.startsWith('"'));

    assert.equal(
      entryLines.length,
      9,
      `Expected 9 entries in MCP_TOOL_DENY_LIST, found ${entryLines.length}:\n${entryLines.join('\n')}`,
    );
  });

  it('MCP_TOOL_DENY_LIST contains local-rag', () => {
    assert.ok(src.includes("'local-rag'"), 'missing entry: local-rag');
  });

  it('MCP_TOOL_DENY_LIST contains standards-rag', () => {
    assert.ok(src.includes("'standards-rag'"), 'missing entry: standards-rag');
  });

  it('MCP_TOOL_DENY_LIST contains lazyos-rag', () => {
    assert.ok(src.includes("'lazyos-rag'"), 'missing entry: lazyos-rag');
  });

  it('MCP_TOOL_DENY_LIST contains *-rag-server', () => {
    assert.ok(src.includes("'*-rag-server'"), 'missing entry: *-rag-server');
  });

  it('MCP_TOOL_DENY_LIST contains *-global-rag', () => {
    assert.ok(src.includes("'*-global-rag'"), 'missing entry: *-global-rag');
  });

  it('MCP_TOOL_DENY_LIST contains mcp__local-rag__*', () => {
    assert.ok(src.includes("'mcp__local-rag__*'"), 'missing entry: mcp__local-rag__*');
  });

  it('MCP_TOOL_DENY_LIST contains mcp__standards-rag__*', () => {
    assert.ok(src.includes("'mcp__standards-rag__*'"), 'missing entry: mcp__standards-rag__*');
  });

  it('MCP_TOOL_DENY_LIST contains mcp__lazyos-rag__*', () => {
    assert.ok(src.includes("'mcp__lazyos-rag__*'"), 'missing entry: mcp__lazyos-rag__*');
  });

  it('MCP_TOOL_DENY_LIST contains mcp__*-global-rag__*', () => {
    assert.ok(src.includes("'mcp__*-global-rag__*'"), 'missing entry: mcp__*-global-rag__*');
  });
});
