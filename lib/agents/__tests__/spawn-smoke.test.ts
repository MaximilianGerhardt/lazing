// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// Smoke-test: spawn 3 subagents in parallel + fleet registry shows live
// status with role-tagged panes (BACKPORT-02 acceptance §6.5-3).
//
// This is the integration-level test the BACKPORT-PLAN demands —
// `spawnSwarm` must drive 3 distinct lanes through the resource-pool
// and the fleet-registry must reflect them as 3 panes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resourcePool } from '../resource-pool';
import type { CpuRamMonitor } from '../cpu-ram-monitor';
import { createSubagentSpawner, type SpawnerAdapter, type SpawnerAdapterFactory } from '../spawner';
import { __resetFleetRegistry, getFleet } from '../fleet-registry';
import { ingestLaneEvent } from '../fleet-registry';

const PERMISSIVE_MONITOR: CpuRamMonitor = {
  snapshot: () => ({ loadAvg1m: 0, freeBytes: Number.MAX_SAFE_INTEGER, totalBytes: Number.MAX_SAFE_INTEGER, capturedAt: Date.now() }),
  canSpawnHeavy: () => true,
  reason: () => 'permissive',
  __stop: () => undefined,
};

function noopFactory(): SpawnerAdapterFactory {
  return () =>
    ({
      async runOnce({ systemPrompt: _sp, userMessage }) {
        // Echo the intent so the smoke output is observable.
        return { text: `ok: ${userMessage.slice(0, 40)}`, durationMs: 5 };
      },
    }) satisfies SpawnerAdapter;
}

beforeEach(() => {
  resourcePool.__reset();
  __resetFleetRegistry();
});
afterEach(() => {
  resourcePool.__reset();
  __resetFleetRegistry();
});

describe('Fleet smoke-test', () => {
  it('spawns 3 subagents in parallel and the registry shows 3 panes', async () => {
    const factory = noopFactory();
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
    });
    const fleetId = 'smoke-fleet-001';
    const intent = 'Backport spawner + fleet card smoke';

    const events = [];
    for await (const ev of spawner.spawnSwarm({
      roles: ['architect', 'coder', 'reviewer'] as const,
      intent: { intentText: intent },
      topology: 'hierarchical',
      parentWorkstreamId: 'ws-smoke',
      worktreePaths: [process.cwd(), process.cwd(), process.cwd()],
      // codex has perKind ceiling 3 — exactly matches our 3-lane fleet.
      engines: ['codex', 'codex', 'codex'],
    })) {
      ingestLaneEvent(fleetId, ev, { intentText: intent });
      events.push(ev);
    }

    // Spawner produced started + text-delta + end per lane.
    const startedCount = events.filter((e) => e.kind === 'started').length;
    const endedCount = events.filter((e) => e.kind === 'end').length;
    expect(startedCount).toBe(3);
    expect(endedCount).toBe(3);

    // Fleet registry now has 3 panes — all done.
    const fleet = getFleet(fleetId);
    expect(fleet).not.toBeNull();
    expect(fleet!.panes).toHaveLength(3);
    expect(fleet!.panes.every((p) => p.status === 'done')).toBe(true);
    const roles = new Set(fleet!.panes.map((p) => p.role));
    expect(roles).toEqual(new Set(['architect', 'coder', 'reviewer']));

    // Pool is fully drained.
    expect(resourcePool.getInflight()).toHaveLength(0);
  });

  it('respects N11 heavyTotal=2 cap when spawning > 2 concurrent heavy lanes', async () => {
    // 4 concurrent lanes — heavyTotal cap = 2, so 2 lanes queue and
    // serialize behind the first 2. All 4 must still complete via the
    // drain-on-release path.
    const factory: SpawnerAdapterFactory = () =>
      ({
        async runOnce({ userMessage }) {
          // Force ordering — small delay so the queue actually backs up.
          await new Promise((r) => setTimeout(r, 10));
          return { text: `ok: ${userMessage.slice(0, 20)}`, durationMs: 10 };
        },
      }) satisfies SpawnerAdapter;
    const spawner = createSubagentSpawner({
      adapterFactory: factory,
      cpuRamMonitor: PERMISSIVE_MONITOR,
    });

    const fleetId = 'smoke-fleet-002';
    const intent = 'Heavy cap stress';
    const events = [];
    for await (const ev of spawner.spawnSwarm({
      roles: ['coder', 'coder', 'reviewer', 'tester'] as const,
      intent: { intentText: intent },
      topology: 'mesh',
      parentWorkstreamId: 'ws-smoke-002',
      worktreePaths: Array(4).fill(process.cwd()),
      engines: ['codex', 'codex', 'codex', 'codex'],
    })) {
      ingestLaneEvent(fleetId, ev, { intentText: intent });
      events.push(ev);
    }

    expect(events.filter((e) => e.kind === 'started')).toHaveLength(4);
    expect(events.filter((e) => e.kind === 'end')).toHaveLength(4);

    const fleet = getFleet(fleetId);
    expect(fleet).not.toBeNull();
    expect(fleet!.panes).toHaveLength(4);
    expect(fleet!.panes.every((p) => p.status === 'done')).toBe(true);

    // Slot ledger drained.
    expect(resourcePool.getInflight()).toHaveLength(0);
  });
});
