/**
 * Tests fuer den Phase-Stepper-Builder in BugFixSwarmCard.tsx
 * (Welle 5 lib/ui/pip · 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/chat/__tests__/bug-fix-swarm-card-stepper.test.ts`
 *
 * Cases:
 *   1. phase=diagnose -> hypothesize is running, predecessors done
 *   2. phase=consensus -> critic is running, plan done
 *   3. phase=disagreement -> critic is running (User-Wahl-Block)
 *   4. phase=fix -> fix running, critic done
 *   5. phase=rootcause -> verify running
 *   6. phase=done -> ALL done
 *   7. phase=failed -> letzter Step failed
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildStepperSteps } from '../BugFixSwarmCard';

describe('buildStepperSteps', () => {
  it('diagnose -> hypothesize running, earlier done', () => {
    const steps = buildStepperSteps('diagnose');
    const detect = steps.find((s) => s.key === 'detect')!;
    const analyze = steps.find((s) => s.key === 'analyze')!;
    const hypo = steps.find((s) => s.key === 'hypothesize')!;
    const plan = steps.find((s) => s.key === 'plan')!;
    assert.equal(detect.status, 'done');
    assert.equal(analyze.status, 'done');
    assert.equal(hypo.status, 'running');
    assert.equal(plan.status, 'pending');
  });

  it('consensus -> critic running, plan done', () => {
    const steps = buildStepperSteps('consensus');
    const plan = steps.find((s) => s.key === 'plan')!;
    const critic = steps.find((s) => s.key === 'critic')!;
    const fix = steps.find((s) => s.key === 'fix')!;
    assert.equal(plan.status, 'done');
    assert.equal(critic.status, 'running');
    assert.equal(fix.status, 'pending');
  });

  it('disagreement -> critic running (User-Wahl-Block)', () => {
    const steps = buildStepperSteps('disagreement');
    const critic = steps.find((s) => s.key === 'critic')!;
    assert.equal(critic.status, 'running');
  });

  it('fix -> fix running, critic done', () => {
    const steps = buildStepperSteps('fix');
    const critic = steps.find((s) => s.key === 'critic')!;
    const fix = steps.find((s) => s.key === 'fix')!;
    const verify = steps.find((s) => s.key === 'verify')!;
    assert.equal(critic.status, 'done');
    assert.equal(fix.status, 'running');
    assert.equal(verify.status, 'pending');
  });

  it('rootcause -> verify running', () => {
    const steps = buildStepperSteps('rootcause');
    const fix = steps.find((s) => s.key === 'fix')!;
    const verify = steps.find((s) => s.key === 'verify')!;
    const audit = steps.find((s) => s.key === 'audit')!;
    assert.equal(fix.status, 'done');
    assert.equal(verify.status, 'running');
    assert.equal(audit.status, 'pending');
  });

  it('done -> ALL steps done', () => {
    const steps = buildStepperSteps('done');
    for (const s of steps) {
      assert.equal(s.status, 'done', `step ${s.key} should be done`);
    }
  });

  it('failed -> last active step is failed', () => {
    const steps = buildStepperSteps('failed');
    const failedSteps = steps.filter((s) => s.status === 'failed');
    assert.ok(failedSteps.length >= 1, 'at least one step should be failed');
  });

  it('all 9 phases are present in the order detect→audit (incl. sweep at 5.5)', () => {
    const steps = buildStepperSteps('diagnose');
    const keys = steps.map((s) => s.key);
    assert.deepEqual(keys, [
      'detect',
      'analyze',
      'hypothesize',
      'plan',
      'critic',
      'sweep',
      'fix',
      'verify',
      'audit',
    ]);
  });
});
