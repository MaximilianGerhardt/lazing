// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// k1-drift.test.ts — K1 deny-pattern drift guard (P2-#8, 2026-05-25).
//
// Asserts that all K1 import sites agree on exactly the same frozen
// deny-pattern list. A failure here means the K1 hard-block (N2/POS-8) has
// silently diverged between layers — a security regression.
//
// Structure:
//   Part A (runtime) — imports lib/security/k1-deny-patterns + binding-resolver,
//                      verifies frozen set, content, and matchesK1Deny behaviour.
//
//   Part B (static)  — reads tool-registry-filter.ts and tmux-spawn.ts SOURCE
//                      TEXT and asserts each consumer imports from the shared
//                      module (not a redeclared literal array). This avoids
//                      the transitive import problem when __shared modules are
//                      absent from lib-v1/mcp.
//
// Uses node:test + node:assert (executable via tsx --test).
// Run:
//   npx tsx --test lib/routines/__tests__/k1-drift.test.ts

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { K1_MCP_QUALIFIED_DENY_PATTERNS } from '../../security/k1-deny-patterns';
import { matchesK1Deny } from '../binding-resolver';

// ─────────────────────────────────────────────────────────────────────────────
// Part A: Runtime assertions — canonical set + matchesK1Deny integration
// ─────────────────────────────────────────────────────────────────────────────

describe('K1 deny-pattern drift guard — Part A: canonical set (runtime)', () => {

  it('canonical set is frozen (integrity guard)', () => {
    assert.ok(Object.isFrozen(K1_MCP_QUALIFIED_DENY_PATTERNS));
  });

  it('canonical set has exactly 4 entries', () => {
    assert.equal(K1_MCP_QUALIFIED_DENY_PATTERNS.length, 4);
  });

  it('canonical set contains mcp__local-rag__*', () => {
    assert.ok(
      ([...K1_MCP_QUALIFIED_DENY_PATTERNS] as string[]).includes('mcp__local-rag__*'),
    );
  });

  it('canonical set contains mcp__standards-rag__*', () => {
    assert.ok(
      ([...K1_MCP_QUALIFIED_DENY_PATTERNS] as string[]).includes('mcp__standards-rag__*'),
    );
  });

  it('canonical set contains mcp__lazyos-rag__*', () => {
    assert.ok(
      ([...K1_MCP_QUALIFIED_DENY_PATTERNS] as string[]).includes('mcp__lazyos-rag__*'),
    );
  });

  it('canonical set contains mcp__*-global-rag__*', () => {
    assert.ok(
      ([...K1_MCP_QUALIFIED_DENY_PATTERNS] as string[]).includes('mcp__*-global-rag__*'),
    );
  });

  describe('matchesK1Deny — blocks all canonical K1 patterns', () => {
    it('blocks mcp__local-rag__query', () => {
      assert.equal(matchesK1Deny('mcp__local-rag__query'), true);
    });

    it('blocks mcp__standards-rag__search', () => {
      assert.equal(matchesK1Deny('mcp__standards-rag__search'), true);
    });

    it('blocks mcp__lazyos-rag__fetch_chunk', () => {
      assert.equal(matchesK1Deny('mcp__lazyos-rag__fetch_chunk'), true);
    });

    it('blocks mcp__acme-global-rag__retrieve (embedded wildcard)', () => {
      assert.equal(matchesK1Deny('mcp__acme-global-rag__retrieve'), true);
    });

    it('blocks mcp__client-global-rag__search_all', () => {
      assert.equal(matchesK1Deny('mcp__client-global-rag__search_all'), true);
    });
  });

  describe('matchesK1Deny — does NOT block legitimate tools', () => {
    it('does not block mcp__heygen__render', () => {
      assert.equal(matchesK1Deny('mcp__heygen__render'), false);
    });

    it('does not block mcp__github__create_pr', () => {
      assert.equal(matchesK1Deny('mcp__github__create_pr'), false);
    });

    it('does not block mcp__memory__store', () => {
      assert.equal(matchesK1Deny('mcp__memory__store'), false);
    });

    it('does not block mcp__ruv-swarm__agent_spawn', () => {
      assert.equal(matchesK1Deny('mcp__ruv-swarm__agent_spawn'), false);
    });

    it('does not block mcp__notrag__query (no known rag server)', () => {
      assert.equal(matchesK1Deny('mcp__notrag__query'), false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Part B: Static source assertions — all consumer files import from shared module
//
// These tests read the source text of consumer files and verify:
//   1. No consumer re-declares the patterns as a literal array.
//   2. Each consumer imports from lib/security/k1-deny-patterns (the SSoT).
// ─────────────────────────────────────────────────────────────────────────────

// Three levels up from lib/routines/__tests__/ → repo root
const ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');

function readSource(relPath: string): string {
  return readFileSync(`${ROOT}/${relPath}`, 'utf8');
}

describe('K1 deny-pattern drift guard — Part B: static source assertions', () => {

  describe('binding-resolver.ts imports from shared module', () => {
    const src = readSource('lib/routines/binding-resolver.ts');

    it('imports K1_MCP_QUALIFIED_DENY_PATTERNS from @/lib/security/k1-deny-patterns', () => {
      assert.ok(
        src.includes("from '@/lib/security/k1-deny-patterns'") ||
        src.includes('from "@/lib/security/k1-deny-patterns"'),
        'binding-resolver.ts must import from @/lib/security/k1-deny-patterns',
      );
    });

    it('does NOT redeclare the pattern array inline (no mcp__local-rag__ string literal)', () => {
      // A re-declaration would look like: const K1_RAG_DENY_PATTERNS = Object.freeze(['mcp__local-rag__*', ...])
      // We detect it by checking for 'mcp__local-rag__' OUTSIDE of a comment or import statement.
      // Simple heuristic: count occurrences; should only appear in import/comment context.
      const lines = src.split('\n');
      const redeclLines = lines.filter(
        (l) =>
          l.includes("'mcp__local-rag__") &&
          !l.trimStart().startsWith('//') &&
          !l.trimStart().startsWith('*') &&
          !l.includes('import'),
      );
      assert.equal(
        redeclLines.length,
        0,
        `binding-resolver.ts must not re-declare mcp__local-rag__ inline. Found:\n${redeclLines.join('\n')}`,
      );
    });
  });

  describe('tmux-spawn.ts imports from shared module', () => {
    const src = readSource('server/agents/tmux-spawn.ts');

    it('imports K1_MCP_QUALIFIED_DENY_PATTERNS from ../../lib/security/k1-deny-patterns', () => {
      assert.ok(
        src.includes("from '../../lib/security/k1-deny-patterns'") ||
        src.includes('from "../../lib/security/k1-deny-patterns"'),
        'tmux-spawn.ts must import from ../../lib/security/k1-deny-patterns',
      );
    });

    it('does NOT redeclare the pattern array inline (no mcp__local-rag__ string literal)', () => {
      const lines = src.split('\n');
      const redeclLines = lines.filter(
        (l) =>
          l.includes("'mcp__local-rag__") &&
          !l.trimStart().startsWith('//') &&
          !l.trimStart().startsWith('*') &&
          !l.includes('import'),
      );
      assert.equal(
        redeclLines.length,
        0,
        `tmux-spawn.ts must not re-declare mcp__local-rag__ inline. Found:\n${redeclLines.join('\n')}`,
      );
    });
  });

  describe('tool-registry-filter.ts re-exports from shared module', () => {
    const src = readSource('lib-v1/mcp/tool-registry-filter.ts');

    it('imports _K1_SHARED from ../../lib/security/k1-deny-patterns', () => {
      assert.ok(
        src.includes("from '../../lib/security/k1-deny-patterns'") ||
        src.includes('from "../../lib/security/k1-deny-patterns"'),
        'tool-registry-filter.ts must import from ../../lib/security/k1-deny-patterns',
      );
    });

    it('exports K1_MCP_QUALIFIED_DENY_PATTERNS as the imported constant (no new array)', () => {
      // The export must be the imported alias, not a new Object.freeze([...]) literal.
      assert.ok(
        src.includes('K1_MCP_QUALIFIED_DENY_PATTERNS = _K1_SHARED'),
        'tool-registry-filter.ts must re-export _K1_SHARED as K1_MCP_QUALIFIED_DENY_PATTERNS',
      );
    });
  });

  describe('k1-deny-patterns.ts is zero-dep and has all 4 patterns', () => {
    const src = readSource('lib/security/k1-deny-patterns.ts');

    it('has NO imports (zero-dependency module)', () => {
      const importLines = src.split('\n').filter(
        (l) => l.trimStart().startsWith('import ') && !l.trimStart().startsWith('import type'),
      );
      assert.equal(
        importLines.length,
        0,
        `k1-deny-patterns.ts must have zero runtime imports. Found:\n${importLines.join('\n')}`,
      );
    });

    it('exports K1_MCP_QUALIFIED_DENY_PATTERNS as a frozen array with 4 entries', () => {
      assert.ok(src.includes('K1_MCP_QUALIFIED_DENY_PATTERNS'), 'must export K1_MCP_QUALIFIED_DENY_PATTERNS');
      assert.ok(src.includes('Object.freeze'), 'must freeze the export');
    });

    it('contains all 4 expected patterns', () => {
      assert.ok(src.includes("'mcp__local-rag__*'"), 'missing mcp__local-rag__*');
      assert.ok(src.includes("'mcp__standards-rag__*'"), 'missing mcp__standards-rag__*');
      assert.ok(src.includes("'mcp__lazyos-rag__*'"), 'missing mcp__lazyos-rag__*');
      assert.ok(src.includes("'mcp__*-global-rag__*'"), 'missing mcp__*-global-rag__*');
    });
  });
});
