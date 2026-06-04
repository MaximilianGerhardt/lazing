// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// binding-resolver.test.ts — Security contract tests for SAR-4.
//
// Uses node:test + node:assert (executable via tsx --test, no rolldown native needed).
// Run: npx tsx --test --test-force-exit lib/routines/__tests__/binding-resolver.test.ts
//
// Five required security cases:
//   (a) K1-Deny gewinnt über explizite Allowlist
//   (b) Unbekanntes MCP-Tool (nicht discovered) → denied
//   (c) Unbekannte Rolle → minimaler Tool-Satz
//   (d) Leere Allowlist → keine MCP-Tools
//   (e) Glob-Match: mcp__foo-global-rag__bar geblockt,
//       mcp__heygen__render durchgelassen wenn discovered

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  matchesK1Deny,
  resolveBinding,
  auditBindingResolution,
  type RoutineBinding,
  type BindingAuditPayload,
} from '../binding-resolver';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: a realistic discovered-tools set for tests that need it
// ─────────────────────────────────────────────────────────────────────────────

const DISCOVERED: string[] = [
  'mcp__heygen__render',
  'mcp__github__list_repos',
  'mcp__github__create_pr',
  'mcp__memory__store',
];

// ─────────────────────────────────────────────────────────────────────────────
// (a) K1-Deny gewinnt über explizite Allowlist
// ─────────────────────────────────────────────────────────────────────────────

describe('(a) K1-Deny gewinnt über explizite Allowlist', () => {
  it('mcp__local-rag__query wird geblockt auch wenn explizit erlaubt', () => {
    const binding: RoutineBinding = {
      subagentRole: 'researcher',
      mcpToolAllowlist: ['mcp__local-rag__query_documents'],
    };
    const result = resolveBinding(binding, { discoveredTools: ['mcp__local-rag__query_documents'] });
    assert.equal(result.mcpTools.length, 0, 'mcpTools muss leer sein');
    assert.ok(
      result.deniedMcpTools.includes('mcp__local-rag__query_documents'),
      'geblockt muss in deniedMcpTools erscheinen',
    );
  });

  it('mcp__standards-rag__search wird geblockt auch wenn discovered', () => {
    const binding: RoutineBinding = {
      subagentRole: 'coder',
      mcpToolAllowlist: ['mcp__standards-rag__search'],
    };
    const result = resolveBinding(binding, {
      discoveredTools: ['mcp__standards-rag__search', 'mcp__heygen__render'],
    });
    assert.ok(
      !result.mcpTools.includes('mcp__standards-rag__search'),
      'standards-rag darf nicht in mcpTools',
    );
    assert.ok(
      result.deniedMcpTools.includes('mcp__standards-rag__search'),
      'standards-rag muss in deniedMcpTools',
    );
  });

  it('mcp__lazyos-rag__fetch wird geblockt', () => {
    const binding: RoutineBinding = {
      mcpToolAllowlist: ['mcp__lazyos-rag__fetch'],
    };
    const result = resolveBinding(binding, { discoveredTools: ['mcp__lazyos-rag__fetch'] });
    assert.equal(result.mcpTools.length, 0);
    assert.ok(result.deniedMcpTools.includes('mcp__lazyos-rag__fetch'));
  });

  it('K1-geblockte Tools erscheinen NICHT in mcpTools, egal ob discovered oder nicht', () => {
    const binding: RoutineBinding = {
      mcpToolAllowlist: [
        'mcp__lazyos-rag__anything',
        'mcp__heygen__render',
      ],
    };
    const result = resolveBinding(binding, { discoveredTools: DISCOVERED });
    assert.deepEqual(result.mcpTools, ['mcp__heygen__render'], 'nur heygen darf durch');
    assert.deepEqual(result.deniedMcpTools, ['mcp__lazyos-rag__anything'], 'rag geblockt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Unbekanntes MCP-Tool (nicht in discoveredTools) → denied
// ─────────────────────────────────────────────────────────────────────────────

describe('(b) Unbekanntes MCP-Tool (nicht discovered) → denied', () => {
  it('tool nicht in discoveredTools → in deniedMcpTools', () => {
    const binding: RoutineBinding = {
      subagentRole: 'researcher',
      mcpToolAllowlist: ['mcp__nonexistent__do_thing'],
    };
    const result = resolveBinding(binding, { discoveredTools: DISCOVERED });
    assert.equal(result.mcpTools.length, 0);
    assert.ok(result.deniedMcpTools.includes('mcp__nonexistent__do_thing'));
  });

  it('mix: bekanntes + unbekanntes Tool → nur bekanntes durch', () => {
    const binding: RoutineBinding = {
      mcpToolAllowlist: ['mcp__github__list_repos', 'mcp__ghost__publish'],
    };
    const result = resolveBinding(binding, { discoveredTools: DISCOVERED });
    assert.deepEqual(result.mcpTools, ['mcp__github__list_repos']);
    assert.ok(result.deniedMcpTools.includes('mcp__ghost__publish'));
  });

  it('ohne discoveredTools-Option → alle MCP-Tools denied (fail-safe)', () => {
    const binding: RoutineBinding = {
      mcpToolAllowlist: ['mcp__heygen__render'],
    };
    // No discoveredTools provided → discovery info absent → all denied
    const result = resolveBinding(binding);
    assert.equal(result.mcpTools.length, 0);
    assert.ok(result.deniedMcpTools.includes('mcp__heygen__render'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Unbekannte Rolle → minimaler Tool-Satz
// ─────────────────────────────────────────────────────────────────────────────

describe('(c) Unbekannte Rolle → minimaler Tool-Satz', () => {
  it('komplett unbekannte Rolle → role=unknown, nur Read+Grep+Glob', () => {
    const binding: RoutineBinding = {
      subagentRole: 'superadmin',
    };
    const result = resolveBinding(binding);
    assert.equal(result.role, 'unknown');
    assert.ok(result.allowedTools.includes('Read'));
    assert.ok(result.allowedTools.includes('Grep'));
    assert.ok(result.allowedTools.includes('Glob'));
    assert.ok(!result.allowedTools.includes('Bash'), 'Bash darf nicht bei unknown');
    assert.ok(!result.allowedTools.includes('Write'), 'Write darf nicht bei unknown');
    assert.ok(!result.allowedTools.includes('Edit'), 'Edit darf nicht bei unknown');
    assert.equal(result.allowedTools.length, 3, 'genau 3 conservative tools');
  });

  it('leere Rolle → role=unknown, nur Read+Grep+Glob', () => {
    const result = resolveBinding({ subagentRole: '' });
    assert.equal(result.role, 'unknown');
    assert.equal(result.allowedTools.length, 3);
  });

  it('fehlende Rolle (undefined) → role=unknown', () => {
    const result = resolveBinding({});
    assert.equal(result.role, 'unknown');
    assert.equal(result.allowedTools.length, 3);
  });

  it('bekannte Rolle coder → role=coder, Bash+Write+Edit erlaubt', () => {
    const result = resolveBinding({ subagentRole: 'coder' });
    assert.equal(result.role, 'coder');
    assert.ok(result.allowedTools.includes('Bash'));
    assert.ok(result.allowedTools.includes('Write'));
    assert.ok(result.allowedTools.includes('Edit'));
  });

  it('bekannte Rolle reviewer → kein Bash, kein Write, Read vorhanden', () => {
    const result = resolveBinding({ subagentRole: 'reviewer' });
    assert.equal(result.role, 'reviewer');
    assert.ok(!result.allowedTools.includes('Bash'));
    assert.ok(!result.allowedTools.includes('Write'));
    assert.ok(result.allowedTools.includes('Read'));
  });

  it('bekannte Rolle security → kein Bash, kein Write (read-only)', () => {
    const result = resolveBinding({ subagentRole: 'security' });
    assert.equal(result.role, 'security');
    assert.ok(!result.allowedTools.includes('Bash'));
    assert.ok(result.allowedTools.includes('Read'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) Leere Allowlist → keine MCP-Tools
// ─────────────────────────────────────────────────────────────────────────────

describe('(d) Leere Allowlist → keine MCP-Tools', () => {
  it('leeres Array mcpToolAllowlist → mcpTools:[], deniedMcpTools:[]', () => {
    const result = resolveBinding(
      { subagentRole: 'researcher', mcpToolAllowlist: [] },
      { discoveredTools: DISCOVERED },
    );
    assert.equal(result.mcpTools.length, 0);
    assert.equal(result.deniedMcpTools.length, 0);
  });

  it('fehlende mcpToolAllowlist → mcpTools:[], deniedMcpTools:[]', () => {
    const result = resolveBinding(
      { subagentRole: 'coder' },
      { discoveredTools: DISCOVERED },
    );
    assert.equal(result.mcpTools.length, 0);
    assert.equal(result.deniedMcpTools.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (e) Glob-Match: mcp__foo-global-rag__bar geblockt, mcp__heygen__render durch
// ─────────────────────────────────────────────────────────────────────────────

describe('(e) Glob-Match Korrektheit', () => {
  describe('matchesK1Deny()', () => {
    // --- geblockt (K1-Treffer) ---
    it('mcp__local-rag__any_tool → geblockt', () => {
      assert.equal(matchesK1Deny('mcp__local-rag__any_tool'), true);
    });

    it('mcp__standards-rag__search → geblockt', () => {
      assert.equal(matchesK1Deny('mcp__standards-rag__search'), true);
    });

    it('mcp__lazyos-rag__fetch_chunk → geblockt', () => {
      assert.equal(matchesK1Deny('mcp__lazyos-rag__fetch_chunk'), true);
    });

    it('mcp__foo-global-rag__bar → geblockt (embedded wildcard pattern)', () => {
      assert.equal(matchesK1Deny('mcp__foo-global-rag__bar'), true,
        'mcp__*-global-rag__* pattern muss greifen');
    });

    it('mcp__my-org-global-rag__query → geblockt', () => {
      assert.equal(matchesK1Deny('mcp__my-org-global-rag__query'), true);
    });

    it('mcp__client-global-rag__search_all → geblockt', () => {
      assert.equal(matchesK1Deny('mcp__client-global-rag__search_all'), true);
    });

    // --- erlaubt (kein K1-Treffer) ---
    it('mcp__heygen__render → nicht geblockt', () => {
      assert.equal(matchesK1Deny('mcp__heygen__render'), false);
    });

    it('mcp__github__list_repos → nicht geblockt', () => {
      assert.equal(matchesK1Deny('mcp__github__list_repos'), false);
    });

    it('mcp__memory__store → nicht geblockt', () => {
      assert.equal(matchesK1Deny('mcp__memory__store'), false);
    });

    it('mcp__ruv-swarm__agent_spawn → nicht geblockt', () => {
      assert.equal(matchesK1Deny('mcp__ruv-swarm__agent_spawn'), false);
    });

    it('mcp__storage__migrate → nicht geblockt (kein rag-Muster)', () => {
      assert.equal(matchesK1Deny('mcp__storage__migrate'), false);
    });

    it('mcp__notrag__query → nicht geblockt (kein bekanntes K1-Muster)', () => {
      assert.equal(matchesK1Deny('mcp__notrag__query'), false);
    });
  });

  it('mcp__foo-global-rag__bar geblockt, mcp__heygen__render durch wenn discovered', () => {
    const binding: RoutineBinding = {
      subagentRole: 'researcher',
      mcpToolAllowlist: ['mcp__foo-global-rag__bar', 'mcp__heygen__render'],
    };
    const result = resolveBinding(binding, { discoveredTools: DISCOVERED });
    assert.deepEqual(result.mcpTools, ['mcp__heygen__render']);
    assert.deepEqual(result.deniedMcpTools, ['mcp__foo-global-rag__bar']);
  });

  it('alle vier K1-Patterns geblockt in einer Allowlist', () => {
    const binding: RoutineBinding = {
      mcpToolAllowlist: [
        'mcp__local-rag__q',
        'mcp__standards-rag__q',
        'mcp__lazyos-rag__q',
        'mcp__acme-global-rag__q',
        'mcp__heygen__render', // darf durch
      ],
    };
    const result = resolveBinding(binding, { discoveredTools: DISCOVERED });
    assert.deepEqual(result.mcpTools, ['mcp__heygen__render']);
    assert.equal(result.deniedMcpTools.length, 4);
    assert.ok(result.deniedMcpTools.includes('mcp__local-rag__q'));
    assert.ok(result.deniedMcpTools.includes('mcp__standards-rag__q'));
    assert.ok(result.deniedMcpTools.includes('mcp__lazyos-rag__q'));
    assert.ok(result.deniedMcpTools.includes('mcp__acme-global-rag__q'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional: SAFE_TOOLS defense-in-depth
// ─────────────────────────────────────────────────────────────────────────────

describe('SAFE_TOOLS defense-in-depth', () => {
  it('skill-names aus role-skill-map die kein SAFE_TOOL sind, erscheinen NICHT in allowedTools', () => {
    // 'researcher' has 'web-search', 'web-fetch', 'skills:risk-projector' etc.
    // None of these are in SAFE_TOOLS → must be filtered out.
    const result = resolveBinding({ subagentRole: 'researcher' });
    const SAFE = new Set(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob']);
    for (const tool of result.allowedTools) {
      assert.ok(SAFE.has(tool), `"${tool}" ist kein SAFE_TOOL`);
    }
  });

  it('planner role hat keine Bash — nur Read+Grep+Glob aus SAFE_TOOLS', () => {
    const result = resolveBinding({ subagentRole: 'planner' });
    assert.ok(!result.allowedTools.includes('Bash'), 'planner darf kein Bash');
    assert.ok(result.allowedTools.includes('Read'));
    assert.ok(result.allowedTools.includes('Grep'));
    assert.ok(result.allowedTools.includes('Glob'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N8 Audit hook shape
// ─────────────────────────────────────────────────────────────────────────────

describe('auditBindingResolution — N8 hook', () => {
  it('übergibt Payload vollständig an den onAudit-Callback', () => {
    const binding: RoutineBinding = {
      subagentRole: 'coder',
      mcpToolAllowlist: ['mcp__github__list_repos'],
    };
    const resolved = resolveBinding(binding, { discoveredTools: DISCOVERED });
    const payload: BindingAuditPayload = {
      routineId: 'test-routine-1',
      workspaceId: 'ws-abc',
      binding,
      resolved,
      decidedAt: 1716000000000,
    };

    let captured: BindingAuditPayload | undefined;
    auditBindingResolution(payload, (p) => { captured = p; });

    assert.ok(captured !== undefined, 'callback muss gerufen werden');
    assert.equal(captured?.routineId, 'test-routine-1');
    assert.ok(captured?.resolved.mcpTools.includes('mcp__github__list_repos'));
  });

  it('wenn onAudit wirft, propagiert der Fehler (SAR-3 muss rollback)', () => {
    const binding: RoutineBinding = {};
    const resolved = resolveBinding(binding);
    const payload: BindingAuditPayload = {
      routineId: 'x',
      workspaceId: 'ws-y',
      binding,
      resolved,
      decidedAt: Date.now(),
    };
    assert.throws(
      () => auditBindingResolution(payload, () => { throw new Error('db-write-failed'); }),
      /db-write-failed/,
    );
  });
});
