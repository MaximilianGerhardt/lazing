// SPDX-License-Identifier: GPL-3.0-or-later
//
// BACKPORT-02 smoke-runner — exercises the SubagentSpawner + fleet
// registry without depending on vitest (the local sandbox has a broken
// rolldown native-binding on darwin-arm64 in this checkout).
//
// Run via: `npx tsx scripts/smoke-subagent-fleet.ts`
// Exits 0 on success, 1 on any failure.

import { strict as assert } from 'node:assert';

import {
  createSubagentSpawner,
  resourcePool,
  type SpawnerAdapter,
  type SpawnerAdapterFactory,
  type SubagentLaneEvent,
} from '../lib/agents';
import {
  __resetFleetRegistry,
  getFleet,
  ingestLaneEvent,
} from '../lib/agents/fleet-registry';

const factory: SpawnerAdapterFactory = () =>
  ({
    async runOnce({ userMessage }) {
      // Tiny artificial delay so concurrent lanes interleave realistically.
      await new Promise((r) => setTimeout(r, 5));
      return { text: `ok: ${userMessage.slice(0, 30)}`, durationMs: 5 };
    },
  }) satisfies SpawnerAdapter;

async function smokeSpawn3Parallel(): Promise<void> {
  resourcePool.__reset();
  __resetFleetRegistry();

  const spawner = createSubagentSpawner({ adapterFactory: factory });
  const fleetId = 'smoke-fleet-001';
  const intent = 'Backport spawner + fleet card smoke';

  const events: { kind: string; role: string }[] = [];
  for await (const ev of spawner.spawnSwarm({
    roles: ['architect', 'coder', 'reviewer'] as const,
    intent: { intentText: intent },
    topology: 'hierarchical',
    parentWorkstreamId: 'ws-smoke',
    worktreePaths: [process.cwd(), process.cwd(), process.cwd()],
    engines: ['codex', 'codex', 'codex'],
  })) {
    ingestLaneEvent(fleetId, ev, { intentText: intent });
    events.push({ kind: ev.kind, role: ev.role });
  }

  const started = events.filter((e) => e.kind === 'started').length;
  const ended = events.filter((e) => e.kind === 'end').length;
  assert.equal(started, 3, `started events should be 3, got ${started}`);
  assert.equal(ended, 3, `end events should be 3, got ${ended}`);

  const fleet = getFleet(fleetId);
  assert.ok(fleet, 'fleet should exist in registry');
  assert.equal(fleet.panes.length, 3, `fleet should have 3 panes, got ${fleet.panes.length}`);
  assert.ok(
    fleet.panes.every((p) => p.status === 'done'),
    `all panes should be done; got ${fleet.panes.map((p) => p.status).join(',')}`,
  );
  const roles = new Set(fleet.panes.map((p) => p.role));
  assert.equal(roles.size, 3, `should have 3 distinct roles, got ${[...roles].join(',')}`);

  assert.equal(resourcePool.getInflight().length, 0, 'pool should be drained');

  console.log(`[smoke-1] 3-parallel spawn: 3 started, 3 ended, fleet panes done=${fleet.panes.length}`);
}

async function smokeN11HeavyCap(): Promise<void> {
  resourcePool.__reset();
  __resetFleetRegistry();

  // 4 lanes against heavyTotal=2 — 2 lanes queue and serialize behind
  // the first 2. All 4 must still complete via drain-on-release.
  const spawner = createSubagentSpawner({ adapterFactory: factory });
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

  assert.equal(events.filter((e) => e.kind === 'started').length, 4);
  assert.equal(events.filter((e) => e.kind === 'end').length, 4);
  const fleet = getFleet(fleetId);
  assert.ok(fleet);
  assert.equal(fleet.panes.length, 4);
  assert.ok(fleet.panes.every((p) => p.status === 'done'));
  assert.equal(resourcePool.getInflight().length, 0);
  console.log(`[smoke-2] heavyTotal=2 stress: 4 spawned, all done, drained`);
}

async function smokeBudgetSerialization(): Promise<void> {
  resourcePool.__reset();
  __resetFleetRegistry();

  // Pre-fill the pool to heavyTotal so an immediate spawn must queue.
  const slotA = await resourcePool.acquireSlot({ kind: 'claude-cli', subagentId: 'pre-A' });
  const slotB = await resourcePool.acquireSlot({ kind: 'codex', subagentId: 'pre-B' });
  assert.equal(resourcePool.getInflight().length, 2);

  const spawner = createSubagentSpawner({ adapterFactory: factory, slotTimeoutMs: 200 });
  const ev: SubagentLaneEvent[] = [];
  // Run the third lane in background, then release a slot — it should
  // drain immediately.
  const drained = (async () => {
    for await (const e of spawner.spawnSubagent({
      role: 'coder',
      intent: { intentText: 'queued' },
      parentWorkstreamId: 'ws-q',
      worktreePath: process.cwd(),
      engine: 'codex',
    })) {
      ev.push(e);
    }
  })();

  // Give the queue 20ms to actually back up, then release one slot.
  await new Promise((r) => setTimeout(r, 20));
  resourcePool.releaseSlot(slotA.slotId);

  await drained;
  resourcePool.releaseSlot(slotB.slotId);

  assert.equal(resourcePool.getInflight().length, 0);
  const kinds = ev.map((e) => e.kind);
  assert.ok(kinds.includes('end'), `queued lane should have ended; events=${kinds.join(',')}`);
  console.log(`[smoke-3] queue-then-drain: pool serialized + queued lane completed`);
}

(async () => {
  try {
    await smokeSpawn3Parallel();
    await smokeN11HeavyCap();
    await smokeBudgetSerialization();
    console.log('\nBACKPORT-02 smoke-test: ALL GREEN');
    process.exit(0);
  } catch (err) {
    console.error('\nBACKPORT-02 smoke-test: FAILED');
    console.error(err);
    process.exit(1);
  }
})();
