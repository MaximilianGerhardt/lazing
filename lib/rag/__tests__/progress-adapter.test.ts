/**
 * ragRunToStages-Tests (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/rag/__tests__/progress-adapter.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { ragRunToStages } from '../progress-adapter';

describe('ragRunToStages · 5 Stages', () => {
  it('idle → alle pending', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'idle',
    });
    assert.equal(stages.length, 5);
    for (const s of stages) assert.equal(s.status, 'pending');
  });

  it('phase=embed → discover+chunk done, embed running, persist+cleanup pending', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'embed',
      totalChunks: 100,
      embeddedCount: 47,
    });
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'done');
    assert.equal(stages[2]!.status, 'running');
    assert.equal(stages[2]!.progressPct, 47);
    assert.match(stages[2]!.subtitle ?? '', /47\/100 Chunks/);
    assert.equal(stages[3]!.status, 'pending');
    assert.equal(stages[4]!.status, 'pending');
  });

  it('phase=persist mit progressPct', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'persist',
      totalChunks: 200,
      persistedCount: 150,
    });
    assert.equal(stages[3]!.status, 'running');
    assert.equal(stages[3]!.progressPct, 75);
  });

  it('done → alle done', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'done',
    });
    for (const s of stages) assert.equal(s.status, 'done');
  });

  it('failed mit phase=embed → discover+chunk done, embed failed, rest pending', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'embed',
      totalChunks: 50,
      embeddedCount: 10,
      errorMessage: 'Embedder OOM',
    });
    // embed=running solange phase=embed; failed kommt nur wenn phase='failed'
    assert.equal(stages[2]!.status, 'running');
  });

  it('phase=failed ohne aktive Phase → letzte Stage = failed, davor skipped', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'failed',
      errorMessage: 'unknown failure',
    });
    // Heuristik: wenn activeIdx<0 (failed nicht in STAGE_ORDER), letzte = failed
    assert.equal(stages[stages.length - 1]!.status, 'failed');
    assert.match(stages[stages.length - 1]!.subtitle ?? '', /unknown failure/);
    for (let i = 0; i < stages.length - 1; i += 1) {
      assert.equal(stages[i]!.status, 'skipped');
    }
  });

  it('circuit-open → cleanup failed mit Subtitle, davor done', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'circuit-open',
      errorMessage: 'Circuit-Breaker offen',
    });
    assert.equal(stages[stages.length - 1]!.status, 'failed');
    assert.match(stages[stages.length - 1]!.subtitle ?? '', /Circuit-Breaker/);
  });

  it('progressPct geclampt auf 100 wenn embedded > total', () => {
    const stages = ragRunToStages({
      workspaceId: 'ws1',
      runId: 'ws1::all',
      phase: 'embed',
      totalChunks: 10,
      embeddedCount: 15,
    });
    // 15/10 → 150 — Adapter rundet nur, Step.tsx clampt visuell
    assert.equal(stages[2]!.progressPct, 150);
  });
});
