// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// SubagentSpawner unit tests (vitest, happy-dom-friendly).
//
// BACKPORT-02 (2026-05-23) — Ported from Lazing V2 `spawner.test.ts`
// (386 LOC). The lazyos `SpawnerAdapter` surface is single-shot, so the
// stream-token assertions collapse to "exactly one text-delta + one end"
// — the lane-event contract is otherwise identical.
//
// M-WORK-01 (2026-05-25) — Three new describe blocks test the worktree
// isolation wiring added in Checkup P1-#6:
//   • text-only spawns → zero createRunWorktree calls (BYTE-IDENTICAL)
//   • write-mode spawns → createRunWorktree called + workspacePath = worktree
//   • N11 cap exhausted → fail-closed error event, no live-path fallback

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resourcePool } from '../resource-pool';
import type { CpuRamMonitor } from '../cpu-ram-monitor';
import { composeSubagentSystemPrompt, ROLE_PROMPT_TEMPLATES } from '../role-prompts';
import { ROLE_SKILL_MAP } from '../role-skill-map';
import { createSubagentSpawner, type SpawnerAdapter, type SpawnerAdapterFactory } from '../spawner';
import type { SubagentLaneEvent, SubagentRole } from '../spawner-types';

// Tests run on a CI box that may have transient high loadavg. The real
// gate is exercised explicitly in its own describe block; for the
// happy-path tests we inject a permissive monitor so the gate never
// false-positives the suite.
const PERMISSIVE_MONITOR: CpuRamMonitor = {
  snapshot: () => ({ loadAvg1m: 0, freeBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER, capturedAt: Date.now() }),
  canSpawnHeavy: () => true,
  reason: () => 'permissive',
  __stop: () => undefined,
};

interface AdapterCallRecord {
  readonly engine: string;
  readonly workspacePath: string;
  readonly allowedSkills: readonly string[];
  readonly systemPrompt: string;
  readonly userMessage: string;
}

function makeStubFactory(
  result: { text: string; durationMs?: number } | null,
  throwOnRun?: Error,
): { factory: SpawnerAdapterFactory; calls: AdapterCallRecord[] } {
  const calls: AdapterCallRecord[] = [];
  const factory: SpawnerAdapterFactory = (input) => {
    const adapter: SpawnerAdapter = {
      async runOnce(args) {
        calls.push({
          engine: input.engine,
          workspacePath: input.workspacePath,
          allowedSkills: input.allowedSkills,
          systemPrompt: args.systemPrompt,
          userMessage: args.userMessage,
        });
        if (throwOnRun) throw throwOnRun;
        return result ?? { text: '' };
      },
    };
    return adapter;
  };
  return { factory, calls };
}

beforeEach(() => resourcePool.__reset());
afterEach(() => resourcePool.__reset());

const INTENT_TEXT = 'Implementiere das Hooks-Routing exakt so, wie beschrieben.';

describe('SubagentSpawner.spawnSubagent', () => {
  it('yields started → text-delta → end annotated with subagentId+role', async () => {
    const { factory, calls } = makeStubFactory({ text: 'Hallo Welt', durationMs: 50 });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      now: () => 1_700_000_000_000,
      idGen: () => 'sub-coder-fixed01',
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: INTENT_TEXT },
      parentWorkstreamId: 'ws-parent-1',
      worktreePath: '/tmp/sub-coder-aaaa0000',
      engine: 'claude-cli',
    })) {
      events.push(ev);
    }

    expect(events[0]).toMatchObject({
      kind: 'started',
      subagentId: 'sub-coder-fixed01',
      role: 'coder',
      engine: 'claude-cli',
    });
    const textEvents = events.filter((e) => e.kind === 'text-delta');
    expect(textEvents).toHaveLength(1);
    expect(textEvents[0]!).toMatchObject({ subagentId: 'sub-coder-fixed01', role: 'coder' });

    const endEvents = events.filter((e) => e.kind === 'end');
    expect(endEvents).toHaveLength(1);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.engine).toBe('claude-cli');
    expect(calls[0]!.workspacePath).toBe('/tmp/sub-coder-aaaa0000');

    // N1 — intent passed verbatim as userMessage
    expect(calls[0]!.userMessage).toBe(INTENT_TEXT);

    // System prompt contains the role template AND the verbatim intent
    expect(calls[0]!.systemPrompt).toContain(ROLE_PROMPT_TEMPLATES.coder);
    expect(calls[0]!.systemPrompt).toContain(INTENT_TEXT);

    // Skills allow-list defaulted from the role map
    expect(calls[0]!.allowedSkills).toEqual(ROLE_SKILL_MAP.coder);

    // Pool was released — inflight is empty.
    expect(resourcePool.getInflight()).toHaveLength(0);
  });

  it('releases the pool slot when the adapter throws synchronously', async () => {
    const { factory } = makeStubFactory(null, new Error('boom'));
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
    });
    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: INTENT_TEXT },
      parentWorkstreamId: 'p',
      worktreePath: '/tmp/wt',
      engine: 'codex',
    })) {
      events.push(ev);
    }
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    expect(events[events.length - 1]!.kind).toBe('error');
    expect(resourcePool.getInflight()).toHaveLength(0);
  });

  it('emits error when the slot acquire times out', async () => {
    // Pre-fill the pool to the heavyTotal cap so the next acquire blocks
    // until the spawner's slotTimeoutMs override forces the rejection.
    await resourcePool.acquireSlot({ kind: 'claude-cli', subagentId: 'x' });
    await resourcePool.acquireSlot({ kind: 'codex', subagentId: 'y' });

    const { factory, calls } = makeStubFactory({ text: '' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      slotTimeoutMs: 25,
    });
    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'reviewer',
      intent: { intentText: INTENT_TEXT },
      parentWorkstreamId: 'p',
      worktreePath: '/tmp/wt',
      engine: 'codex',
    })) {
      events.push(ev);
    }
    expect(calls).toHaveLength(0);
    expect(events.some((e) => e.kind === 'error' && /timeout|aborted/i.test(e.message))).toBe(true);
    expect(events[events.length - 1]!.kind).toBe('error');
  });

  it('forwards an explicit skillsAllowed override to the adapter factory', async () => {
    const { factory, calls } = makeStubFactory({ text: 'ok' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
    });
    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'security',
      intent: { intentText: INTENT_TEXT },
      parentWorkstreamId: 'p',
      worktreePath: '/tmp/wt',
      engine: 'codex',
      skillsAllowed: ['read', 'grep'],
    })) {
      events.push(ev);
    }
    expect(calls[0]!.allowedSkills).toEqual(['read', 'grep']);
  });
});

describe('SubagentSpawner.spawnSwarm', () => {
  it('fans out N roles in parallel and multiplexes their events', async () => {
    const { factory, calls } = makeStubFactory({ text: 'x' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
    });
    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSwarm({
      roles: ['architect', 'coder', 'reviewer'] as const,
      intent: { intentText: INTENT_TEXT },
      topology: 'hierarchical',
      parentWorkstreamId: 'p',
      worktreePaths: ['/tmp/a', '/tmp/c', '/tmp/r'],
      engines: ['codex', 'codex', 'codex'],
    })) {
      events.push(ev);
    }
    expect(calls).toHaveLength(3);

    const roles = new Set(events.map((e) => e.role));
    expect(roles).toEqual(new Set<SubagentRole>(['architect', 'coder', 'reviewer']));

    for (const role of ['architect', 'coder', 'reviewer'] as const) {
      expect(events.some((e) => e.role === role && e.kind === 'started')).toBe(true);
      expect(events.some((e) => e.role === role && e.kind === 'end')).toBe(true);
    }
    expect(resourcePool.getInflight()).toHaveLength(0);
  });

  it('throws when roles / worktreePaths / engines lengths diverge', async () => {
    const { factory } = makeStubFactory({ text: '' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
    });
    await expect(async () => {
      // eslint-disable-next-line no-empty
      for await (const _ of spawner.spawnSwarm({
        roles: ['coder'],
        intent: { intentText: INTENT_TEXT },
        topology: 'sequential',
        parentWorkstreamId: 'p',
        worktreePaths: ['/tmp/a', '/tmp/b'],
        engines: ['codex'],
      })) {
      }
    }).rejects.toThrow(/same length/);
  });
});

describe('SubagentSpawner CPU/RAM gate', () => {
  it('refuses heavy spawn with system-overload when monitor.canSpawnHeavy() === false', async () => {
    const { factory, calls } = makeStubFactory({ text: 'should never run' });
    const blockingMonitor = {
      snapshot: () => ({
        loadAvg1m: 16,
        freeBytes: 0,
        totalBytes: 32 * 1024 * 1024 * 1024,
        capturedAt: Date.now(),
      }),
      canSpawnHeavy: () => false,
      reason: () => 'loadavg 16 > maxLoad 8',
      __stop: () => undefined,
    };
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: blockingMonitor,
      idGen: () => 'sub-coder-fixed02',
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'do thing' },
      parentWorkstreamId: 'ws-parent-1',
      worktreePath: '/tmp/sub-coder-overload',
      engine: 'claude-cli',
    })) {
      events.push(ev);
    }
    expect(calls.length).toBe(0);
    expect(events[0]!.kind).toBe('started');
    const err = events.find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    expect(err!.kind === 'error' ? err!.code : '').toBe('system-overload');
  });

  it('symmetric: gates ollama-heavy under overload', async () => {
    const { factory, calls } = makeStubFactory({ text: 'remote-api' });
    const blockingMonitor = {
      snapshot: () => ({
        loadAvg1m: 16,
        freeBytes: 0,
        totalBytes: 32 * 1024 * 1024 * 1024,
        capturedAt: Date.now(),
      }),
      canSpawnHeavy: () => false,
      reason: () => 'overload',
      __stop: () => undefined,
    };
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: blockingMonitor,
      idGen: () => 'sub-reviewer-x',
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'reviewer',
      intent: { intentText: 'review' },
      parentWorkstreamId: 'ws-parent-1',
      worktreePath: '/tmp/sub-reviewer-overload',
      engine: 'ollama-heavy',
    })) {
      events.push(ev);
    }
    expect(calls.length).toBe(0);
    const err = events.find((e) => e.kind === 'error');
    expect(err!.kind === 'error' ? err!.code : '').toBe('system-overload');
  });
});

// ─── M-WORK-01: Worktree isolation wiring ─────────────────────────────────
//
// These tests use vi.mock to intercept calls to worktree-manager without
// touching the real git binary.  The mocked module is imported AFTER the
// mock declaration so vitest hoisting resolves correctly.
//
// Security invariant under test:
//   • text-only spawns → zero createRunWorktree calls, zero FS effects.
//   • write-mode spawns → createRunWorktree called; adapter receives the
//     isolated path (NOT the caller-supplied worktreePath).
//   • N11 cap → fail-closed: error event emitted, live path NEVER used.

vi.mock('../worktree-manager', () => {
  return {
    createRunWorktree: vi.fn(),
    discardRunWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

// We import the mocked functions here so we can control return values.
// Using a lazy getter so the mock is established before the import runs.
import * as worktreeManager from '../worktree-manager';

describe('M-WORK-01 (worktree isolation): text-only spawn → no worktree', () => {
  beforeEach(() => {
    resourcePool.__reset();
    vi.mocked(worktreeManager.createRunWorktree).mockReset();
    vi.mocked(worktreeManager.discardRunWorktree).mockReset();
    vi.mocked(worktreeManager.discardRunWorktree).mockResolvedValue(undefined);
  });
  afterEach(() => resourcePool.__reset());

  it('never calls createRunWorktree when allowedTools is undefined (text-only default)', async () => {
    const { factory } = makeStubFactory({ text: 'text-only-result' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      // worktreeConfig IS present, but allowedTools is missing → text-only
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-test-01' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'researcher',
      intent: { intentText: 'Research something' },
      parentWorkstreamId: 'ws-parent-text',
      worktreePath: '/tmp/text-only-path',
      engine: 'claude-cli',
      // allowedTools: undefined — text-only
    })) {
      events.push(ev);
    }

    // Text-only spawn must complete successfully
    expect(events.some((e) => e.kind === 'end')).toBe(true);
    expect(events.some((e) => e.kind === 'error')).toBe(false);

    // The critical assertion: zero FS side-effects
    expect(worktreeManager.createRunWorktree).not.toHaveBeenCalled();
    expect(worktreeManager.discardRunWorktree).not.toHaveBeenCalled();
  });

  it('never calls createRunWorktree when allowedTools is empty array', async () => {
    const { factory } = makeStubFactory({ text: 'text-only-result' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-test-01' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'planner',
      intent: { intentText: 'Plan something' },
      parentWorkstreamId: 'ws-parent-text',
      worktreePath: '/tmp/text-only-path',
      engine: 'codex',
      allowedTools: [], // empty = text-only
    })) {
      events.push(ev);
    }

    expect(events.some((e) => e.kind === 'end')).toBe(true);
    expect(worktreeManager.createRunWorktree).not.toHaveBeenCalled();
    expect(worktreeManager.discardRunWorktree).not.toHaveBeenCalled();
  });

  it('never calls createRunWorktree when allowedTools has only Read/Grep (no Write/Edit/Bash)', async () => {
    const { factory } = makeStubFactory({ text: 'read-only-result' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-test-01' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'reviewer',
      intent: { intentText: 'Review something' },
      parentWorkstreamId: 'ws-parent-text',
      worktreePath: '/tmp/text-only-path',
      engine: 'codex',
      allowedTools: ['Read', 'Grep', 'Glob'], // read-only tools, no write-mode trigger
    })) {
      events.push(ev);
    }

    expect(events.some((e) => e.kind === 'end')).toBe(true);
    expect(worktreeManager.createRunWorktree).not.toHaveBeenCalled();
    expect(worktreeManager.discardRunWorktree).not.toHaveBeenCalled();
  });
});

describe('M-WORK-01 (worktree isolation): write-mode spawn → isolated worktree', () => {
  const ISOLATED_WORKTREE_PATH = '/fake-wt-base/ws-test-01/sub-coder-writAAA/';

  beforeEach(() => {
    resourcePool.__reset();
    vi.mocked(worktreeManager.createRunWorktree).mockReset();
    vi.mocked(worktreeManager.discardRunWorktree).mockReset();
    vi.mocked(worktreeManager.createRunWorktree).mockResolvedValue({
      worktreePath: ISOLATED_WORKTREE_PATH,
      branch: 'lazing/run/sub-coder-writAAA',
    });
    vi.mocked(worktreeManager.discardRunWorktree).mockResolvedValue(undefined);
  });
  afterEach(() => resourcePool.__reset());

  it('calls createRunWorktree when allowedTools contains Write', async () => {
    const { factory, calls } = makeStubFactory({ text: 'wrote-something' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-test-01' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'Write a feature' },
      parentWorkstreamId: 'ws-parent-write',
      worktreePath: '/tmp/live-repo-should-not-be-used',
      engine: 'claude-cli',
      allowedTools: ['Read', 'Write', 'Edit'], // Write triggers write-mode
    })) {
      events.push(ev);
    }

    // createRunWorktree must have been called exactly once
    expect(worktreeManager.createRunWorktree).toHaveBeenCalledOnce();
    const createArgs = vi.mocked(worktreeManager.createRunWorktree).mock.calls[0]![0];
    expect(createArgs.repoPath).toBe('/fake/repo');
    expect(createArgs.workspaceId).toBe('ws-test-01');

    // The adapter factory must receive the isolated path, NOT the caller's path
    expect(calls).toHaveLength(1);
    expect(calls[0]!.workspacePath).toBe(ISOLATED_WORKTREE_PATH);
    expect(calls[0]!.workspacePath).not.toBe('/tmp/live-repo-should-not-be-used');

    // Spawn completes normally
    expect(events.some((e) => e.kind === 'end')).toBe(true);
    expect(events.some((e) => e.kind === 'error')).toBe(false);

    // The worktree branch is reflected in lane events
    const startedEv = events.find((e) => e.kind === 'started');
    expect(startedEv?.worktreeBranch).toBe('lazing/run/sub-coder-writAAA');
  });

  it('calls createRunWorktree when allowedTools contains Bash', async () => {
    const { factory } = makeStubFactory({ text: 'bash-result' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-test-01' },
    });

    for await (const _ of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'Run a bash command' },
      parentWorkstreamId: 'ws-parent-bash',
      worktreePath: '/tmp/live-should-not-be-used',
      engine: 'claude-cli',
      allowedTools: ['Bash'], // Bash alone triggers write-mode
    })) { /* drain */ }

    expect(worktreeManager.createRunWorktree).toHaveBeenCalledOnce();
  });

  it('discardRunWorktree is called in finally even when adapter throws', async () => {
    const { factory } = makeStubFactory(null, new Error('adapter-boom'));
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-test-01' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'Will fail' },
      parentWorkstreamId: 'ws-parent-fail',
      worktreePath: '/tmp/live-path',
      engine: 'claude-cli',
      allowedTools: ['Write'],
    })) {
      events.push(ev);
    }

    expect(events.some((e) => e.kind === 'error')).toBe(true);

    // Even on adapter failure, worktree must be cleaned up.
    // discardRunWorktree is async fire-and-forget from finally — we need to
    // flush the microtask queue before asserting.
    await Promise.resolve();
    await Promise.resolve();
    expect(worktreeManager.discardRunWorktree).toHaveBeenCalledOnce();
  });

  it('does NOT call createRunWorktree when worktreeConfig is absent (legacy path)', async () => {
    const { factory, calls } = makeStubFactory({ text: 'legacy-ok' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      // NO worktreeConfig — legacy/test path
    });

    for await (const _ of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'Legacy write spawn' },
      parentWorkstreamId: 'ws-legacy',
      worktreePath: '/tmp/legacy-path',
      engine: 'claude-cli',
      allowedTools: ['Write', 'Edit', 'Bash'],
    })) { /* drain */ }

    // Without worktreeConfig, write-mode falls back to caller's path (legacy behaviour)
    expect(worktreeManager.createRunWorktree).not.toHaveBeenCalled();
    expect(calls[0]!.workspacePath).toBe('/tmp/legacy-path');
  });
});

describe('M-WORK-01 (worktree isolation): N11 cap → fail-closed', () => {
  beforeEach(() => {
    resourcePool.__reset();
    vi.mocked(worktreeManager.createRunWorktree).mockReset();
    vi.mocked(worktreeManager.discardRunWorktree).mockReset();
    vi.mocked(worktreeManager.discardRunWorktree).mockResolvedValue(undefined);
  });
  afterEach(() => resourcePool.__reset());

  it('emits worktree-cap-exhausted error and never uses live path when N11 cap hit', async () => {
    // Simulate the exact error worktree-manager throws at cap
    vi.mocked(worktreeManager.createRunWorktree).mockRejectedValue(
      new Error(
        'N11_WORKTREE_CAP: cannot create worktree — 5 run worktrees already exist (cap=5).',
      ),
    );

    const { factory, calls } = makeStubFactory({ text: 'should-not-run' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-cap-test' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'Capped spawn' },
      parentWorkstreamId: 'ws-cap',
      worktreePath: '/tmp/live-repo-must-not-be-used',
      engine: 'claude-cli',
      allowedTools: ['Write', 'Edit'],
    })) {
      events.push(ev);
    }

    // Must emit exactly one error event with code 'worktree-cap-exhausted'
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.kind === 'error' ? errEvent!.code : '').toBe('worktree-cap-exhausted');

    // No 'end' event — spawn was aborted before the adapter ran
    expect(events.some((e) => e.kind === 'end')).toBe(false);

    // The adapter factory must NEVER have been called — live path is untouched
    expect(calls).toHaveLength(0);

    // Resource pool must be clean — no slot leaked
    expect(resourcePool.getInflight()).toHaveLength(0);
  });

  it('emits worktree-create-failed (not cap) for generic create errors, still fail-closed', async () => {
    vi.mocked(worktreeManager.createRunWorktree).mockRejectedValue(
      new Error('WORKTREE_CREATE_FAILED: git worktree add failed'),
    );

    const { factory, calls } = makeStubFactory({ text: 'nope' });
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
      worktreeConfig: { repoPath: '/fake/repo', workspaceId: 'ws-err-test' },
    });

    const events: SubagentLaneEvent[] = [];
    for await (const ev of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'Create will fail' },
      parentWorkstreamId: 'ws-err',
      worktreePath: '/tmp/live-must-not-be-used',
      engine: 'claude-cli',
      allowedTools: ['Edit'],
    })) {
      events.push(ev);
    }

    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.kind === 'error' ? errEvent!.code : '').toBe('worktree-create-failed');
    expect(calls).toHaveLength(0);
    expect(resourcePool.getInflight()).toHaveLength(0);
  });
});

describe('composeSubagentSystemPrompt', () => {
  it('preserves the verbatim intent (N1)', () => {
    const sp = composeSubagentSystemPrompt({
      role: 'coder',
      intentText: INTENT_TEXT,
    });
    expect(sp).toContain(`<intent>\n${INTENT_TEXT}\n</intent>`);
    expect(sp).toContain(ROLE_PROMPT_TEMPLATES.coder);
  });

  it('appends upstream-artifact blocks', () => {
    const sp = composeSubagentSystemPrompt({
      role: 'reviewer',
      intentText: 'verbatim',
      upstreamArtifacts: [
        {
          fromRole: 'architect',
          fromSubagentId: 'sub-architect-xx',
          label: 'plan',
          content: 'do the thing',
        },
      ],
    });
    expect(sp).toContain('<upstream from="architect:sub-architect-xx" label="plan">');
    expect(sp).toContain('do the thing');
    expect(sp).toContain('</upstream>');
  });

  it('prepends handoff prelude when provided', () => {
    const sp = composeSubagentSystemPrompt({
      role: 'coder',
      intentText: INTENT_TEXT,
      handoff: {
        mainPlanSummary: 'Backport spawner.',
        stepIndex: 2,
        totalSteps: 5,
        role: 'coder',
        requiredCapabilities: ['edit', 'write'],
        dependencies: [{ stepIndex: 1, artifact: 'architect:plan' }],
        expectedArtifacts: ['coder:diff'],
      },
    });
    expect(sp).toContain('=== HANDOFF ===');
    expect(sp).toContain('Main plan: Backport spawner.');
    expect(sp).toContain('Step: 2/5 (role: coder)');
    expect(sp).toContain('Required capabilities: edit, write');
    expect(sp).toContain('Dependencies: step 1 → architect:plan');
    expect(sp).toContain('Expected artifacts (what THIS step produces): coder:diff');
    expect(sp).toContain('=== TASK ===');
  });
});
