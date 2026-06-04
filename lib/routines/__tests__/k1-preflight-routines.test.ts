// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// k1-preflight-routines.test.ts
//
// Verifies the K1 RAG-tool preflight (#6) in:
//   POST /api/routines   (CreateRoutineBodySchema + matchesK1Deny filter)
//   PATCH /api/routines/[id]  (UpdateRoutineBodySchema + matchesK1Deny filter)
//
// Strategy: test the schema-level + matchesK1Deny integration at unit level
// (no Next.js machinery, no DB). The preflight logic is:
//   blocked = body.mcpToolAllowlist.filter(t => matchesK1Deny(t))
//   if (blocked.length > 0) → 400 { error: 'k1_deny', blocked }
//
// Run:
//   NODE_OPTIONS='--experimental-require-module' npx vitest run \
//     lib/routines/__tests__/k1-preflight-routines.test.ts

import { describe, it, expect } from 'vitest';
import { matchesK1Deny } from '../binding-resolver';
import { CreateRoutineBodySchema, UpdateRoutineBodySchema } from '../types';

// ────────────────────────────────────────────────────────────────────────────
// Helper: simulate the preflight logic extracted from the route handlers.
// This mirrors the exact lines in app/api/routines/route.ts and
// app/api/routines/[id]/route.ts so the test is specification-equivalent.
// ────────────────────────────────────────────────────────────────────────────

function preflight(allowlist: string[] | null | undefined): {
  blocked: string[];
  shouldReject: boolean;
} {
  if (!allowlist || allowlist.length === 0) return { blocked: [], shouldReject: false };
  const blocked = allowlist.filter((t) => matchesK1Deny(t));
  return { blocked, shouldReject: blocked.length > 0 };
}

// ────────────────────────────────────────────────────────────────────────────
// POST: K1 tool in mcpToolAllowlist → preflight rejects with 400 k1_deny.
// ────────────────────────────────────────────────────────────────────────────

const BASE_YAML =
  'id: r1\nname: Test\nworkspace_id: ws-1\npipeline:\n' +
  '  - collect_context:\n      commands: ["echo hello"]\n' +
  '  - output_format: markdown\n  - delivery: stdout\n';

describe('POST /api/routines — K1 preflight (#6)', () => {
  it('mcp__local-rag__query in mcpToolAllowlist → blocked (400 k1_deny)', () => {
    const parsed = CreateRoutineBodySchema.safeParse({
      name: 'K1 Test Routine',
      workspaceId: 'ws-k1-001',
      yamlConfig: BASE_YAML,
      actionKind: 'plan-dispatch',
      goalPrompt: 'Do something.',
      mcpToolAllowlist: ['mcp__local-rag__query_documents'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { blocked, shouldReject } = preflight(parsed.data.mcpToolAllowlist);
    expect(shouldReject).toBe(true);
    expect(blocked).toContain('mcp__local-rag__query_documents');
  });

  it('mcp__standards-rag__search in mcpToolAllowlist → blocked', () => {
    const parsed = CreateRoutineBodySchema.safeParse({
      name: 'Standards RAG Routine',
      workspaceId: 'ws-k1-002',
      yamlConfig: BASE_YAML,
      actionKind: 'plan-dispatch',
      goalPrompt: 'Search standards.',
      mcpToolAllowlist: ['mcp__standards-rag__search'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { blocked, shouldReject } = preflight(parsed.data.mcpToolAllowlist);
    expect(shouldReject).toBe(true);
    expect(blocked).toContain('mcp__standards-rag__search');
  });

  it('mcp__client-global-rag__fetch (embedded wildcard) → blocked', () => {
    const parsed = CreateRoutineBodySchema.safeParse({
      name: 'Global RAG Routine',
      workspaceId: 'ws-k1-003',
      yamlConfig: BASE_YAML,
      actionKind: 'plan-dispatch',
      goalPrompt: 'Fetch from global RAG.',
      mcpToolAllowlist: ['mcp__client-global-rag__fetch'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { blocked, shouldReject } = preflight(parsed.data.mcpToolAllowlist);
    expect(shouldReject).toBe(true);
    expect(blocked).toContain('mcp__client-global-rag__fetch');
  });

  it('mix of K1 + legitimate tools → only K1 tools in blocked list', () => {
    const allowlist = [
      'mcp__heygen__render_video',
      'mcp__local-rag__query_documents',
      'mcp__github__create_pr',
    ];
    const { blocked, shouldReject } = preflight(allowlist);
    expect(shouldReject).toBe(true);
    expect(blocked).toEqual(['mcp__local-rag__query_documents']);
    // legitimate tools are NOT in blocked
    expect(blocked).not.toContain('mcp__heygen__render_video');
    expect(blocked).not.toContain('mcp__github__create_pr');
  });

  it('all-legitimate mcpToolAllowlist → no block (200 path)', () => {
    const allowlist = ['mcp__heygen__render_video', 'mcp__github__list_repos'];
    const { blocked, shouldReject } = preflight(allowlist);
    expect(shouldReject).toBe(false);
    expect(blocked).toHaveLength(0);
  });

  it('absent mcpToolAllowlist → no block (200 path)', () => {
    const parsed = CreateRoutineBodySchema.safeParse({
      name: 'No MCP Routine',
      workspaceId: 'ws-k1-004',
      yamlConfig: BASE_YAML,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { shouldReject } = preflight(parsed.data.mcpToolAllowlist);
    expect(shouldReject).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PATCH /api/routines/[id] — same K1 preflight applies.
// ────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/routines/[id] — K1 preflight (#6)', () => {
  it('mcp__lazyos-rag__retrieve in PATCH mcpToolAllowlist → blocked', () => {
    const parsed = UpdateRoutineBodySchema.safeParse({
      mcpToolAllowlist: ['mcp__lazyos-rag__retrieve'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { blocked, shouldReject } = preflight(parsed.data.mcpToolAllowlist ?? []);
    expect(shouldReject).toBe(true);
    expect(blocked).toContain('mcp__lazyos-rag__retrieve');
  });

  it('legitimate-only PATCH mcpToolAllowlist → no block', () => {
    const parsed = UpdateRoutineBodySchema.safeParse({
      mcpToolAllowlist: ['mcp__heygen__render_video'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { shouldReject } = preflight(parsed.data.mcpToolAllowlist ?? []);
    expect(shouldReject).toBe(false);
  });

  it('null mcpToolAllowlist in PATCH (explicit clear) → no block', () => {
    const parsed = UpdateRoutineBodySchema.safeParse({
      mcpToolAllowlist: null,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // null means "clear the column" — no preflight needed
    const { shouldReject } = preflight(parsed.data.mcpToolAllowlist ?? undefined);
    expect(shouldReject).toBe(false);
  });
});
