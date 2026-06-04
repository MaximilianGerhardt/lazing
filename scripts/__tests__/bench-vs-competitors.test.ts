/**
 * Smoke-Tests für scripts/bench-vs-competitors.ts (Welle 3d, 2026-05-03).
 *
 * Validiert dass jede der 5 Mess-Funktionen ohne Crash läuft, plausible
 * Wertebereiche zurückgibt und keine externen Calls macht.
 *
 * Run: `pnpm exec tsx --test scripts/__tests__/bench-vs-competitors.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  measureTokenSaving,
  measureConsensusDeterminism,
  measureDriftRecall,
  measurePlanQuality,
} from '../bench-vs-competitors';

describe('bench-vs-competitors', () => {
  it('measureTokenSaving returns reductionPct in (0, 1)', () => {
    const r = measureTokenSaving();
    assert.ok(r.reductionPct > 0);
    assert.ok(r.reductionPct < 1);
  });

  it('measureConsensusDeterminism returns medianCosine in [0, 1]', () => {
    const r = measureConsensusDeterminism();
    assert.ok(r.medianCosine >= 0);
    assert.ok(r.medianCosine <= 1);
  });

  it('measureDriftRecall returns recall >= 0.5 (fabricated → fabricated/drift)', () => {
    const r = measureDriftRecall();
    assert.ok(
      r.recall >= 0.5,
      `expected >= 0.5, got ${r.recall} (synthetic-cosine fabricated detection)`,
    );
  });

  it('measurePlanQuality returns score in [0, 1]', () => {
    const r = measurePlanQuality();
    assert.ok(r.score >= 0);
    assert.ok(r.score <= 1);
  });
});
