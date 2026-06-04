/**
 * driftAuditToStages-Tests (Sub-Plan 5 Welle 2, 2026-05-01).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { driftAuditToStages } from '../drift-progress-adapter';

describe('driftAuditToStages', () => {
  it('idle → alle 4 pending', () => {
    const stages = driftAuditToStages({ runId: 'r1', phase: 'idle' });
    assert.equal(stages.length, 4);
    for (const s of stages) assert.equal(s.status, 'pending');
  });

  it('re-run mit Progress', () => {
    const stages = driftAuditToStages({
      runId: 'r1',
      phase: 're-run',
      totalTargets: 20,
      processedTargets: 7,
    });
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'running');
    assert.equal(stages[1]!.progressPct, 35);
    assert.match(stages[1]!.subtitle ?? '', /7\/20 Targets/);
    assert.equal(stages[2]!.status, 'pending');
  });

  it('done mit driftFound → report-Subtitle', () => {
    const stages = driftAuditToStages({
      runId: 'r1',
      phase: 'done',
      driftFound: 3,
    });
    for (const s of stages) assert.equal(s.status, 'done');
    assert.match(stages[3]!.subtitle ?? '', /3 Drift-Findings/);
  });

  it('failed ohne aktive Phase → report failed, davor skipped', () => {
    const stages = driftAuditToStages({
      runId: 'r1',
      phase: 'failed',
      errorMessage: 'DB-Fehler',
    });
    assert.equal(stages[stages.length - 1]!.status, 'failed');
    for (let i = 0; i < stages.length - 1; i += 1) {
      assert.equal(stages[i]!.status, 'skipped');
    }
  });
});
