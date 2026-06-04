/**
 * iterateToStages-Tests (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/workstreams/__tests__/iterate-progress-adapter.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { iterateToStages } from '../iterate-progress-adapter';

describe('iterateToStages · V1..Vmax-Mapping', () => {
  it('V1 läuft (lead-v1) → V1=running, V2-5=pending', () => {
    const stages = iterateToStages({
      currentVersion: 1,
      maxVersion: 5,
      phase: 'lead-v1',
      isPaused: false,
    });
    assert.equal(stages.length, 5);
    assert.equal(stages[0]!.status, 'running');
    for (let i = 1; i < 5; i += 1) {
      assert.equal(stages[i]!.status, 'pending');
    }
  });

  it('V3 läuft (roast) → V1+V2=done, V3=running, V4+V5=pending', () => {
    const stages = iterateToStages({
      currentVersion: 3,
      maxVersion: 5,
      phase: 'roast',
      isPaused: false,
    });
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'done');
    assert.equal(stages[2]!.status, 'running');
    assert.equal(stages[3]!.status, 'pending');
    assert.equal(stages[4]!.status, 'pending');
    // Sub-Step für phase=roast
    assert.equal(stages[2]!.sub?.length, 1);
    assert.match(stages[2]!.sub![0]!.label, /Roast V3/);
  });

  it('isPaused + phase=pause → currentVersion-Stage = pending mit Subtitle', () => {
    const stages = iterateToStages({
      currentVersion: 2,
      maxVersion: 5,
      phase: 'pause',
      isPaused: true,
      pauseSecondsRemaining: 23,
    });
    assert.equal(stages[1]!.status, 'pending');
    assert.match(stages[1]!.subtitle ?? '', /noch 23s/);
  });

  it('isAborted → currentVersion = failed', () => {
    const stages = iterateToStages({
      currentVersion: 3,
      maxVersion: 5,
      phase: 'roast',
      isPaused: false,
      isAborted: true,
    });
    assert.equal(stages[2]!.status, 'failed');
    assert.match(stages[2]!.subtitle ?? '', /abgebrochen/);
  });

  it('isCompleted → alle Stages done', () => {
    const stages = iterateToStages({
      currentVersion: 5,
      maxVersion: 5,
      phase: 'done',
      isPaused: false,
      isCompleted: true,
    });
    assert.deepEqual(
      stages.map((s) => s.status),
      ['done', 'done', 'done', 'done', 'done'],
    );
  });

  it('phaseElapsedMs → etaBucket auf running-Stage', () => {
    const stages = iterateToStages({
      currentVersion: 2,
      maxVersion: 5,
      phase: 'roast',
      isPaused: false,
      phaseElapsedMs: 10 * 60_000,
    });
    assert.equal(stages[1]!.etaBucket, 'slow');
  });

  it('IDs sind eindeutig pro Stage', () => {
    const stages = iterateToStages({
      currentVersion: 2,
      maxVersion: 3,
      phase: 'roast',
      isPaused: false,
    });
    const ids = new Set(stages.map((s) => s.id));
    assert.equal(ids.size, 3);
  });
});
