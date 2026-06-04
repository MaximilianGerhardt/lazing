// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// lib/voice/__tests__/voice-tools.test.ts
//
// Tests:
//   - K1 deny check (hard block on deny-pattern tool names).
//   - Registry: register, lookup, duplicate guard.
//   - dispatchTool(): K1-denied → unknown-tool → gate-required → ok.
//   - Built-in tools registered via registerBuiltinVoiceTools().
//   - Key never in events or logs (K1 gate + dispatch path).
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/voice/__tests__/voice-tools.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerVoiceTool,
  getVoiceTool,
  listVoiceTools,
  matchesK1VoiceDeny,
  dispatchTool,
  registerBuiltinVoiceTools,
  K1_VOICE_DENY_PATTERNS,
  _resetRegistry,
} from '../voice-tools';

// ─── Registry reset between tests ────────────────────────────────────────────

beforeEach(() => {
  _resetRegistry();
});

// ─── K1_VOICE_DENY_PATTERNS integrity ────────────────────────────────────────

describe('K1_VOICE_DENY_PATTERNS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(K1_VOICE_DENY_PATTERNS)).toBe(true);
  });

  it('contains expected deny entries', () => {
    expect(K1_VOICE_DENY_PATTERNS).toContain('rag_query');
    expect(K1_VOICE_DENY_PATTERNS).toContain('rag_search');
  });
});

// ─── matchesK1VoiceDeny (pure, N6) ───────────────────────────────────────────

describe('matchesK1VoiceDeny()', () => {
  it('exact match: rag_query → true', () => {
    expect(matchesK1VoiceDeny('rag_query')).toBe(true);
  });

  it('exact match: rag_search → true', () => {
    expect(matchesK1VoiceDeny('rag_search')).toBe(true);
  });

  it('prefix wildcard: global_rag_anything → true', () => {
    expect(matchesK1VoiceDeny('global_rag_search')).toBe(true);
    expect(matchesK1VoiceDeny('global_rag_')).toBe(true);
    expect(matchesK1VoiceDeny('global_rag_xyzabc')).toBe(true);
  });

  it('prefix wildcard: cross_workspace_anything → true', () => {
    expect(matchesK1VoiceDeny('cross_workspace_list')).toBe(true);
  });

  it('prefix wildcard: purge_anything → true', () => {
    expect(matchesK1VoiceDeny('purge_workspace')).toBe(true);
    expect(matchesK1VoiceDeny('purge_all')).toBe(true);
  });

  it('legitimate tool names → false', () => {
    expect(matchesK1VoiceDeny('submit_to_composer')).toBe(false);
    expect(matchesK1VoiceDeny('switch_workspace')).toBe(false);
    expect(matchesK1VoiceDeny('list_workspaces')).toBe(false);
    expect(matchesK1VoiceDeny('spawn_researcher')).toBe(false);
  });

  it('partial prefix without wildcard → false (no partial matching)', () => {
    // 'rag_query_extra' is NOT an exact match for 'rag_query'
    expect(matchesK1VoiceDeny('rag_query_extra')).toBe(false);
  });

  it('empty string → false', () => {
    expect(matchesK1VoiceDeny('')).toBe(false);
  });

  it('deterministic: same input → same output', () => {
    expect(matchesK1VoiceDeny('rag_query')).toBe(matchesK1VoiceDeny('rag_query'));
    expect(matchesK1VoiceDeny('submit_to_composer')).toBe(matchesK1VoiceDeny('submit_to_composer'));
  });
});

// ─── registerVoiceTool / getVoiceTool / listVoiceTools ───────────────────────

describe('registry', () => {
  it('registers and retrieves a tool', () => {
    registerVoiceTool({
      name: 'test_tool',
      description: 'A test tool',
      schema: { type: 'object', properties: {}, additionalProperties: false },
    });
    const tool = getVoiceTool('test_tool');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('test_tool');
  });

  it('listVoiceTools() includes registered tools', () => {
    registerVoiceTool({
      name: 'tool_a',
      description: 'Tool A',
      schema: {},
    });
    registerVoiceTool({
      name: 'tool_b',
      description: 'Tool B',
      schema: {},
    });
    const names = listVoiceTools().map((t) => t.name);
    expect(names).toContain('tool_a');
    expect(names).toContain('tool_b');
  });

  it('throws on duplicate tool name', () => {
    registerVoiceTool({ name: 'dup_tool', description: 'D', schema: {} });
    expect(() => registerVoiceTool({ name: 'dup_tool', description: 'D2', schema: {} })).toThrow(
      /already registered/,
    );
  });

  it('getVoiceTool returns undefined for unknown tool', () => {
    expect(getVoiceTool('nonexistent_tool')).toBeUndefined();
  });
});

// ─── dispatchTool() — gate order ─────────────────────────────────────────────

describe('dispatchTool()', () => {
  it('K1-denied tool → { ok: false, reason: k1-denied }', () => {
    const result = dispatchTool({ callId: 'c1', name: 'rag_query', args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('k1-denied');
      expect(result.detail).toContain('K1');
    }
  });

  it('K1-denied wildcard tool → { ok: false, reason: k1-denied }', () => {
    const result = dispatchTool({ callId: 'c2', name: 'global_rag_search_all', args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('k1-denied');
    }
  });

  it('unknown tool (not registered) → { ok: false, reason: unknown-tool }', () => {
    const result = dispatchTool({ callId: 'c3', name: 'nonexistent_tool_xyz', args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-tool');
    }
  });

  it('registered tool without gate → { ok: true }', () => {
    registerVoiceTool({ name: 'safe_tool', description: 'Safe', schema: {} });
    const result = dispatchTool({ callId: 'c4', name: 'safe_tool', args: {} });
    expect(result.ok).toBe(true);
  });

  it('gated tool without token → { ok: false, reason: gate-required }', () => {
    registerVoiceTool({
      name: 'destructive_tool',
      description: 'Dangerous',
      schema: {},
      requiresGate: true,
    });
    const result = dispatchTool({ callId: 'c5', name: 'destructive_tool', args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('gate-required');
    }
  });

  it('gated tool with token → { ok: true }', () => {
    registerVoiceTool({
      name: 'gated_tool',
      description: 'Needs gate',
      schema: {},
      requiresGate: true,
    });
    const result = dispatchTool(
      { callId: 'c6', name: 'gated_tool', args: {} },
      'valid-gate-token',
    );
    expect(result.ok).toBe(true);
  });

  it('K1 gate cannot be overridden by gate token', () => {
    // Even if a gate token is provided, K1-denied tools are hard-blocked.
    const result = dispatchTool(
      { callId: 'c7', name: 'rag_query', args: {} },
      'gate-token-provided',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('k1-denied');
    }
  });

  it('dispatchTool detail does not contain secrets', () => {
    const result = dispatchTool({ callId: 'c8', name: 'rag_query', args: {} });
    if (!result.ok) {
      expect(result.detail).not.toContain('OPENAI_API_KEY');
      expect(result.detail).not.toContain('sk-');
    }
  });
});

// ─── Built-in tools ───────────────────────────────────────────────────────────

describe('registerBuiltinVoiceTools()', () => {
  it('registers submit_to_composer, switch_workspace, list_workspaces', () => {
    registerBuiltinVoiceTools();
    expect(getVoiceTool('submit_to_composer')).toBeDefined();
    expect(getVoiceTool('switch_workspace')).toBeDefined();
    expect(getVoiceTool('list_workspaces')).toBeDefined();
  });

  it('built-in tools can be dispatched successfully', () => {
    registerBuiltinVoiceTools();
    const r = dispatchTool({ callId: 'bi1', name: 'submit_to_composer', args: { text: 'hello' } });
    expect(r.ok).toBe(true);
  });

  it('built-in tool names are NOT in K1 deny list', () => {
    registerBuiltinVoiceTools();
    for (const tool of listVoiceTools()) {
      expect(matchesK1VoiceDeny(tool.name)).toBe(false);
    }
  });

  it('idempotent: calling twice does not throw', () => {
    expect(() => {
      registerBuiltinVoiceTools();
      registerBuiltinVoiceTools();
    }).not.toThrow();
  });

  it('spawn_researcher and spawn_planner have timeout > 10s', () => {
    registerBuiltinVoiceTools();
    const researcher = getVoiceTool('spawn_researcher');
    const planner = getVoiceTool('spawn_planner');
    expect(researcher?.timeoutMs).toBeGreaterThan(10000);
    expect(planner?.timeoutMs).toBeGreaterThan(10000);
  });
});
