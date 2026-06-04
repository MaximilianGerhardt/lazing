/**
 * workflowRunToStages-Tests (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/workflows/__tests__/progress-adapter.test.ts`
 *
 * Adapter ist DB-frei: alle Tests bauen synthetische
 * WorkflowDefinition + WorkflowRun-Objekte und prüfen das Mapping.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { workflowRunToStages } from '../progress-adapter';
import type { WorkflowDefinition, WorkflowRun } from '../dsl';

function makeDef(stateIds: string[]): WorkflowDefinition {
  return {
    id: 'dev-sprint',
    version: 'v1',
    label: 'Test',
    description: '',
    initialState: stateIds[0]!,
    triggerHints: [],
    states: stateIds.map((id) => ({
      id,
      label: id.toUpperCase(),
      llmSlot: 'none',
      skillBinding: null,
      preConditions: [],
      postConditions: [],
      transitions: [],
      manualOverride: 'allow',
    })),
  };
}

function makeRun(
  currentState: string,
  status: WorkflowRun['status'] = 'running',
  lastTransitionAt = Date.now(),
): WorkflowRun {
  return {
    id: 'r1',
    workflowId: 'dev-sprint',
    definitionVersion: 'v1',
    workspaceId: null,
    workstreamId: null,
    currentState,
    data: {},
    status,
    createdAt: lastTransitionAt - 1000,
    updatedAt: lastTransitionAt,
    lastTransitionAt,
  };
}

describe('workflowRunToStages · linear FSM', () => {
  it('currentState=critic mit 7 States → 1 done, 1 running, 5 pending', () => {
    const def = makeDef([
      'plan',
      'critic',
      'consolidate',
      'impl-spawn',
      'review',
      'deploy-gate',
      'closeout',
    ]);
    const run = makeRun('critic');
    const stages = workflowRunToStages(run, def);

    assert.equal(stages.length, 7);
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'running');
    for (let i = 2; i < 7; i += 1) {
      assert.equal(stages[i]!.status, 'pending', `idx=${i}`);
    }
  });

  it('currentState=plan (initial) → 0 done, 1 running, rest pending', () => {
    const def = makeDef(['plan', 'critic', 'review']);
    const run = makeRun('plan');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.status, 'running');
    assert.equal(stages[1]!.status, 'pending');
    assert.equal(stages[2]!.status, 'pending');
  });

  it('currentState=closeout (last) → alle davor done, last running', () => {
    const def = makeDef(['plan', 'critic', 'closeout']);
    const run = makeRun('closeout');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'done');
    assert.equal(stages[2]!.status, 'running');
  });
});

describe('workflowRunToStages · run.status', () => {
  it('completed → alle Stages done', () => {
    const def = makeDef(['a', 'b', 'c']);
    const run = makeRun('b', 'completed');
    const stages = workflowRunToStages(run, def);
    assert.deepEqual(
      stages.map((s) => s.status),
      ['done', 'done', 'done'],
    );
  });

  it('aborted + active=b → a=done, b=failed, c=pending', () => {
    const def = makeDef(['a', 'b', 'c']);
    const run = makeRun('b', 'aborted');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'failed');
    assert.equal(stages[2]!.status, 'pending');
    assert.match(stages[1]!.subtitle ?? '', /abgebrochen/);
  });

  it('stuck → active-Stage hat Subtitle "stuck — Operator-Intervention"', () => {
    const def = makeDef(['a', 'b', 'c']);
    const run = makeRun('b', 'stuck');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[1]!.status, 'running');
    assert.match(stages[1]!.subtitle ?? '', /stuck/);
    assert.equal(stages[1]!.etaBucket, 'overdue');
  });
});

describe('workflowRunToStages · etaBucket', () => {
  it('lastTransitionAt = jetzt → fast', () => {
    const def = makeDef(['a', 'b']);
    const now = 1_700_000_000_000;
    const run = makeRun('b', 'running', now);
    const stages = workflowRunToStages(run, def, { nowMs: now + 30_000 });
    assert.equal(stages[1]!.etaBucket, 'fast');
  });

  it('lastTransitionAt = vor 10 min → slow', () => {
    const def = makeDef(['a', 'b']);
    const now = 1_700_000_000_000;
    const run = makeRun('b', 'running', now);
    const stages = workflowRunToStages(run, def, { nowMs: now + 10 * 60_000 });
    assert.equal(stages[1]!.etaBucket, 'slow');
  });

  it('lastTransitionAt = vor 60 min → overdue', () => {
    const def = makeDef(['a', 'b']);
    const now = 1_700_000_000_000;
    const run = makeRun('b', 'running', now);
    const stages = workflowRunToStages(run, def, { nowMs: now + 60 * 60_000 });
    assert.equal(stages[1]!.etaBucket, 'overdue');
  });

  it('non-active-Stage hat keinen etaBucket', () => {
    const def = makeDef(['a', 'b', 'c']);
    const run = makeRun('b');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.etaBucket, undefined);
    assert.equal(stages[2]!.etaBucket, undefined);
  });
});

describe('workflowRunToStages · IDs + Labels', () => {
  it('id = "<workflowId>::<stateId>"', () => {
    const def = makeDef(['plan', 'critic']);
    const run = makeRun('plan');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.id, 'dev-sprint::plan');
    assert.equal(stages[1]!.id, 'dev-sprint::critic');
  });

  it('label = state.label', () => {
    const def = makeDef(['plan', 'critic']);
    const run = makeRun('plan');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.label, 'PLAN');
    assert.equal(stages[1]!.label, 'CRITIC');
  });
});

describe('workflowRunToStages · unknown currentState', () => {
  it('currentState in keinem state.id → alle pending', () => {
    const def = makeDef(['a', 'b']);
    const run = makeRun('xxx');
    const stages = workflowRunToStages(run, def);
    assert.equal(stages[0]!.status, 'pending');
    assert.equal(stages[1]!.status, 'pending');
  });
});
