/**
 * Codex Engine Safety Tests — C7 Engine-Layer (2026-05-25)
 *
 * Uses Node's built-in test runner (node:test) + assert — zero external deps.
 * Run: npx tsx --test --test-force-exit lib/llm/engines/__tests__/codex.test.ts
 *
 * Tests the exported `resolveSandboxFlags` helper directly (pure, no spawn) and
 * the orchestrator's parallel-race enforcement via engine-level spy.
 *
 * Test cases:
 *   (a) default (no codexMode)          → -s read-only -a never, no approval_policy
 *   (b) explicit codexMode='read'        → read-only flags
 *   (c) codexMode='write' MISSING env    → falls back to read + console.warn
 *   (d) codexMode='write' WITH env       → workspace-write flags
 *   (e) orchestrator parallel-race       → codex always gets codexMode='read'
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSandboxFlags } from '../codex';

// ---------------------------------------------------------------------------
// (a-d) Pure unit tests for resolveSandboxFlags — no spawn, no I/O.
// ---------------------------------------------------------------------------

describe('resolveSandboxFlags — sandbox flag resolution', () => {
  const originalLazyosCodexWrite = process.env.LAZYOS_CODEX_WRITE;

  beforeEach(() => {
    delete process.env.LAZYOS_CODEX_WRITE;
  });

  afterEach(() => {
    if (originalLazyosCodexWrite === undefined) {
      delete process.env.LAZYOS_CODEX_WRITE;
    } else {
      process.env.LAZYOS_CODEX_WRITE = originalLazyosCodexWrite;
    }
  });

  it('(a) default (codexMode=undefined) → read-only flags, no approval_policy in flags', () => {
    const { flags, effectiveMode } = resolveSandboxFlags(undefined);

    // Must contain -s read-only
    const sIdx = flags.indexOf('-s');
    assert.ok(sIdx !== -1, 'must include -s flag');
    assert.equal(flags[sIdx + 1], 'read-only', '-s value must be read-only');

    // Must contain -a never
    const aIdx = flags.indexOf('-a');
    assert.ok(aIdx !== -1, 'must include -a flag');
    assert.equal(flags[aIdx + 1], 'never', '-a value must be never');

    // Must NOT contain old approval_policy=never style
    assert.ok(
      !flags.join(' ').includes('approval_policy'),
      'must not include legacy approval_policy override',
    );

    assert.equal(effectiveMode, 'read');
  });

  it('(b) explicit codexMode="read" → same read-only flags', () => {
    const { flags, effectiveMode } = resolveSandboxFlags('read');

    assert.equal(flags[flags.indexOf('-s') + 1], 'read-only');
    assert.equal(effectiveMode, 'read');
  });

  it('(c) codexMode="write" WITHOUT LAZYOS_CODEX_WRITE → falls back to read + warns', () => {
    const warnMessages: string[] = [];
    const origWarn = console.warn.bind(console);
    console.warn = (...args: unknown[]) => warnMessages.push(args.map(String).join(' '));

    try {
      delete process.env.LAZYOS_CODEX_WRITE;
      const { flags, effectiveMode } = resolveSandboxFlags('write');

      // Must fall back to read-only.
      assert.equal(
        flags[flags.indexOf('-s') + 1],
        'read-only',
        'without env gate must produce read-only',
      );
      assert.equal(effectiveMode, 'read');

      // Must have warned.
      assert.ok(warnMessages.length > 0, 'console.warn must be called');
      assert.ok(
        warnMessages.some((m) => m.includes('LAZYOS_CODEX_WRITE')),
        'warn must mention LAZYOS_CODEX_WRITE',
      );
    } finally {
      console.warn = origWarn;
    }
  });

  it('(d) codexMode="write" WITH LAZYOS_CODEX_WRITE=1 → workspace-write flags', () => {
    process.env.LAZYOS_CODEX_WRITE = '1';
    const { flags, effectiveMode } = resolveSandboxFlags('write');

    assert.equal(
      flags[flags.indexOf('-s') + 1],
      'workspace-write',
      'with env gate must produce workspace-write',
    );
    assert.equal(effectiveMode, 'write');
  });

  it('(d.2) codexMode="write" WITH LAZYOS_CODEX_WRITE="" (empty) → still read (env not set)', () => {
    process.env.LAZYOS_CODEX_WRITE = '';
    const { effectiveMode } = resolveSandboxFlags('write');
    assert.equal(effectiveMode, 'read', 'empty string env gate must NOT activate write');
  });

  it('(d.3) codexMode="write" WITH LAZYOS_CODEX_WRITE whitespace-only → still read', () => {
    process.env.LAZYOS_CODEX_WRITE = '   ';
    const { effectiveMode } = resolveSandboxFlags('write');
    assert.equal(effectiveMode, 'read', 'whitespace-only env must NOT activate write');
  });
});

// ---------------------------------------------------------------------------
// (e) Orchestrator: parallel-race always enforces codexMode='read' for codex.
// Tests by replacing codexCli.chat at module level — no spawn needed.
// ---------------------------------------------------------------------------

describe('orchestrator — parallel-race enforces codexMode=read', () => {
  it('(e) adversarial caller with codexMode="write" → codex receives codexMode="read"', async () => {
    const { codexCli } = await import('../codex');
    const { claudeCli } = await import('../claude-cli');
    const { ollama } = await import('../ollama');
    const { clearEngineCache } = await import('../selector');

    let capturedCodexMode: string | undefined = 'NOT_SET';

    const origCodexChat = codexCli.chat.bind(codexCli);
    const origCodexDetect = codexCli.detect.bind(codexCli);
    const origClaudeDetect = claudeCli.detect.bind(claudeCli);
    const origOllamaDetect = ollama.detect.bind(ollama);

    // Only codex available so parallel-race must go through codex.
    codexCli.chat = async (req) => {
      capturedCodexMode = req.codexMode;
      return { engine: 'codex-cli', model: 'codex-default', text: 'ok', latencyMs: 1 };
    };
    codexCli.detect = async () => ({
      engine: 'codex-cli', available: true, reason: 'mocked', probeMs: 0,
    });
    claudeCli.detect = async () => ({
      engine: 'claude-cli', available: false, reason: 'mocked', probeMs: 0,
    });
    ollama.detect = async () => ({
      engine: 'ollama', available: false, reason: 'mocked', probeMs: 0,
    });

    clearEngineCache();

    try {
      const { orchestrate } = await import('../../orchestrator');
      await orchestrate({
        mode: 'parallel-all',
        messages: [{ role: 'user', content: 'test' }],
        // Adversarial: caller explicitly passes write — orchestrator must override.
        codexMode: 'write',
      });

      assert.equal(
        capturedCodexMode,
        'read',
        'orchestrator must enforce codexMode=read in parallel-race regardless of caller',
      );
    } finally {
      codexCli.chat = origCodexChat;
      codexCli.detect = origCodexDetect;
      claudeCli.detect = origClaudeDetect;
      ollama.detect = origOllamaDetect;
      clearEngineCache();
    }
  });
});
