/**
 * Workflow-Runner-Tests — Pattern 4 Foundation (2026-05-01).
 *
 * Deckt:
 *   - happy-path: dev-sprint von plan → critic → consolidate →
 *     impl-spawn → review → deploy-gate → closeout → __terminal__
 *   - preCondition fail: stuck-Event emitted, return status='stuck'
 *   - postCondition fail: state nicht weiter, transition blocked,
 *     status='pending'
 *   - manualOverride='forbid': transitionTo() wirft auf deploy-gate
 *   - Versions-Map: v1 + v2 koexistieren via definitionOverride
 *
 * Run: `pnpm exec tsx --test lib/workflows/__tests__/runner.test.ts`
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';

// DB-Pfad VOR dem Import setzen.
if (!process.env.LAZYOS_DB_PATH) {
  process.env.LAZYOS_DB_PATH = join(
    mkdtempSync(join(tmpdir(), 'lazyos-workflows-')),
    'workflows-test.db',
  );
}
process.env.LAZYOS_TEST_DISABLE_FK = '1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dslMod = require('../dsl') as typeof import('../dsl');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const storeMod = require('../store') as typeof import('../store');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const runnerMod = require('../runner') as typeof import('../runner');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const registryMod = require('../registry') as typeof import('../registry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const devSprintMod = require('../definitions/dev-sprint') as typeof import('../definitions/dev-sprint');

const { createRun, loadRun } = storeMod;
const { runWorkflow, transitionTo, evaluateConditions } = runnerMod;
const { getWorkflow } = registryMod;
const { devSprintWorkflow } = devSprintMod;

type DevSprintStateId = 'plan' | 'critic' | 'consolidate' | 'impl-spawn' | 'review' | 'deploy-gate' | 'closeout';

// ---------------------------------------------------------------------------
// Helper: tick-Loop, der Daten injectet (simuliert LLM-Output) bis das Run
// terminal ist. Schutz vor Endlos-Loop bei Bugs durch Iter-Cap.
// ---------------------------------------------------------------------------

interface InjectMap {
  [stateId: string]: Record<string, unknown>;
}

async function tickWithInjects(
  runId: string,
  injects: InjectMap,
  options: { workspaceId: string; workstreamId: string; maxTicks?: number } = {
    workspaceId: 'lazyos',
    workstreamId: 'ws_test',
  },
): Promise<{ finalStatus: string; finalState: string; transitions: string[] }> {
  const max = options.maxTicks ?? 30;
  const transitions: string[] = [];
  for (let i = 0; i < max; i++) {
    const run = await loadRun(runId);
    if (!run) throw new Error('run vanished');
    if (run.status === 'completed' || run.status === 'aborted' || run.status === 'stuck') {
      return { finalStatus: run.status, finalState: run.currentState, transitions };
    }

    const inject = injects[run.currentState];
    const result = await runWorkflow(runId, {
      workspaceId: options.workspaceId,
      workstreamId: options.workstreamId,
      data: inject,
    });

    if (result.status === 'transitioned' && result.toState) {
      transitions.push(`${result.fromState}->${result.toState}`);
    } else if (result.status === 'completed') {
      transitions.push(`${result.fromState}->__terminal__`);
      const after = await loadRun(runId);
      return {
        finalStatus: after?.status ?? 'unknown',
        finalState: after?.currentState ?? result.fromState,
        transitions,
      };
    } else if (result.status === 'stuck') {
      const after = await loadRun(runId);
      return {
        finalStatus: 'stuck',
        finalState: after?.currentState ?? result.fromState,
        transitions,
      };
    } else if (result.status === 'pending') {
      // Inject-data wurde persistiert, post-conditions noch offen → ohne neue
      // Daten bringt der nächste Tick nichts. Test-Fehler.
      throw new Error(
        `pending in state ${result.fromState} ohne fortschritt — fehlende inject-keys: ` +
          (result.failedConditions?.map((c) => c.id).join(',') ?? '?'),
      );
    }
  }
  throw new Error('tick-loop hat maxTicks erreicht ohne terminal status');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dev-sprint happy-path', () => {
  it('läuft alle 7 states bis __terminal__', async () => {
    const run = await createRun({
      workflowId: 'dev-sprint',
      definitionVersion: 'v1',
      workspaceId: 'lazyos',
      workstreamId: 'ws_happy',
      initialState: 'plan',
      initialData: { brief: 'sprint test' },
    });

    const injects: InjectMap = {
      plan: { planV1: { goal: 'do x', scope: ['a'] } },
      critic: { roastTexts: [{ roaster: 'user', weakness: 'unklar' }] },
      consolidate: { planV2: { goal: 'do x', scope: ['a'], addressedRoasts: ['unklar'] } },
      'impl-spawn': { implTickets: ['tck_1', 'tck_2'] },
      review: { reviewVerdict: 'pass' },
      'deploy-gate': { deployApproved: true },
      closeout: { closeoutDone: true },
    };

    const result = await tickWithInjects(run.id, injects, {
      workspaceId: 'lazyos',
      workstreamId: 'ws_happy',
    });

    assert.equal(result.finalStatus, 'completed');
    // Alle 7 transitions sollten passiert sein
    const expectedSequence = [
      'plan->critic',
      'critic->consolidate',
      'consolidate->impl-spawn',
      'impl-spawn->review',
      'review->deploy-gate',
      'deploy-gate->closeout',
      'closeout->__terminal__',
    ];
    assert.deepEqual(result.transitions, expectedSequence);
  });
});

describe('preCondition-fail emits stuck', () => {
  it('critic ohne planV1 in data → stuck mit pre-failed', async () => {
    // Run direkt im critic-state starten OHNE planV1 → preCondition fail
    const run = await createRun({
      workflowId: 'dev-sprint',
      definitionVersion: 'v1',
      workspaceId: 'lazyos',
      workstreamId: 'ws_pre_fail',
      initialState: 'critic',
      initialData: {}, // kein planV1
    });

    const result = await runWorkflow(run.id, {
      workspaceId: 'lazyos',
      workstreamId: 'ws_pre_fail',
    });

    assert.equal(result.status, 'stuck');
    assert.equal(result.fromState, 'critic');
    assert.ok(result.failedConditions && result.failedConditions.length > 0);
    assert.equal(result.failedConditions![0].kind, 'pre');
    assert.equal(result.failedConditions![0].id, 'planV1-required');

    const after = await loadRun(run.id);
    assert.equal(after?.status, 'stuck');
    assert.equal(after?.currentState, 'critic');
  });
});

describe('postCondition-fail keeps state pending', () => {
  it('plan ohne planV1-output bleibt im plan-state mit status=running, return=pending', async () => {
    const run = await createRun({
      workflowId: 'dev-sprint',
      definitionVersion: 'v1',
      workspaceId: 'lazyos',
      workstreamId: 'ws_post_fail',
      initialState: 'plan',
      initialData: {}, // plan hat keine preConditions, post braucht planV1
    });

    const result = await runWorkflow(run.id, {
      workspaceId: 'lazyos',
      workstreamId: 'ws_post_fail',
    });

    assert.equal(result.status, 'pending');
    assert.equal(result.fromState, 'plan');
    assert.ok(result.failedConditions && result.failedConditions.length > 0);
    assert.equal(result.failedConditions![0].kind, 'post');
    assert.equal(result.failedConditions![0].id, 'planV1-present');

    const after = await loadRun(run.id);
    assert.equal(after?.status, 'running');
    assert.equal(after?.currentState, 'plan');
  });
});

describe('manualOverride forbid blockiert transitionTo', () => {
  it('deploy-gate kann nicht via transitionTo geskippt werden', async () => {
    // Run direkt im deploy-gate state starten.
    const run = await createRun({
      workflowId: 'dev-sprint',
      definitionVersion: 'v1',
      workspaceId: 'lazyos',
      workstreamId: 'ws_forbid',
      initialState: 'deploy-gate',
      initialData: { reviewVerdict: 'pass' }, // pre erfüllt, aber deployApproved fehlt
    });

    await assert.rejects(
      () => transitionTo(run.id, 'closeout'),
      /manualOverride='forbid'/,
    );

    const after = await loadRun(run.id);
    assert.equal(after?.currentState, 'deploy-gate');
  });

  it('andere states erlauben transitionTo (manualOverride=allow)', async () => {
    const run = await createRun({
      workflowId: 'dev-sprint',
      definitionVersion: 'v1',
      workspaceId: 'lazyos',
      workstreamId: 'ws_allow',
      initialState: 'plan',
    });
    // plan hat manualOverride='allow' → transitionTo critic ok
    await transitionTo(run.id, 'critic');
    const after = await loadRun(run.id);
    assert.equal(after?.currentState, 'critic');
  });
});

describe('Versions-Map: v1 + v2 koexistieren', () => {
  it('definitionOverride routet auf alternative Definition', async () => {
    // v2-Mock-Definition mit nur 1 state
    const mockV2: import('../dsl').WorkflowDefinition = {
      id: 'dev-sprint',
      version: 'v2',
      label: 'Demo Fitness v2 (mock)',
      description: 'Test',
      initialState: 'mock-only',
      states: [
        {
          id: 'mock-only',
          label: 'Single Mock State',
          llmSlot: 'none',
          skillBinding: null,
          preConditions: [],
          postConditions: [],
          transitions: [{ to: '__terminal__', label: 'direct exit' }],
          manualOverride: 'allow',
        },
      ],
      triggerHints: [],
    };

    // Ein v2-run wird erstellt; runWorkflow per definitionOverride genutzt
    const run = await createRun({
      workflowId: 'dev-sprint',
      definitionVersion: 'v2',
      workspaceId: 'lazyos',
      workstreamId: 'ws_v2',
      initialState: 'mock-only',
    });

    // Da getWorkflow(id, 'v2') in Welle 1 null returns würde, müssen wir die
    // Override-Hook benutzen
    const result = await runWorkflow(
      run.id,
      { workspaceId: 'lazyos', workstreamId: 'ws_v2' },
      { definitionOverride: mockV2 },
    );

    assert.equal(result.status, 'completed');
    const after = await loadRun(run.id);
    assert.equal(after?.status, 'completed');

    // v1 lädt sich völlig unabhängig — bestätigen dass das Registry-Lookup
    // weiterhin auf v1 zeigt:
    const v1Def = getWorkflow('dev-sprint', 'v1');
    assert.ok(v1Def);
    assert.equal(v1Def!.version, 'v1');
    assert.equal(v1Def!.states.length, 7);

    // Default-Lookup (ohne Version) → ebenfalls v1
    const defaultDef = getWorkflow('dev-sprint');
    assert.ok(defaultDef);
    assert.equal(defaultDef!.version, 'v1');
  });
});

describe('evaluateConditions util', () => {
  it('alle ok → ok=true, failed=[]', async () => {
    const result = await evaluateConditions(
      [
        { id: 'x', label: 'always true', check: () => true },
        { id: 'y', label: 'async true', check: async () => true },
      ],
      { workstreamId: 'ws', workspaceId: 'lazyos', data: {} },
    );
    assert.equal(result.ok, true);
    assert.equal(result.failed.length, 0);
  });

  it('eine fail → ok=false, failed enthält id', async () => {
    const result = await evaluateConditions(
      [
        { id: 'a', label: 'ok', check: () => true },
        { id: 'b', label: 'nope', check: () => false },
      ],
      { workstreamId: 'ws', workspaceId: 'lazyos', data: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'b');
  });

  it('throwing check → fail (nicht crash)', async () => {
    const result = await evaluateConditions(
      [
        {
          id: 'thrower',
          label: 'throws',
          check: () => {
            throw new Error('boom');
          },
        },
      ],
      { workstreamId: 'ws', workspaceId: 'lazyos', data: {} },
    );
    assert.equal(result.ok, false);
    assert.equal(result.failed.length, 1);
  });
});

describe('dev-sprint static structure', () => {
  it('hat 7 states', () => {
    assert.equal(devSprintWorkflow.states.length, 7);
  });
  it('initialState=plan', () => {
    assert.equal(devSprintWorkflow.initialState, 'plan');
  });
  it('deploy-gate hat manualOverride=forbid', () => {
    const dg = devSprintWorkflow.states.find((s) => s.id === 'deploy-gate');
    assert.ok(dg);
    assert.equal(dg!.manualOverride, 'forbid');
  });
  it('closeout transitioniert zu __terminal__', () => {
    const co = devSprintWorkflow.states.find((s) => s.id === 'closeout');
    assert.ok(co);
    assert.ok(co!.transitions.some((t) => t.to === '__terminal__'));
  });
  it('all stub workflows registered', () => {
    const ids: import('../dsl').WorkflowId[] = [
      'dev-sprint',
      'field-measurement',
      'legal-brief',
      'design-gate-flow',
      'legal-correspondence',
    ];
    for (const id of ids) {
      const def = getWorkflow(id);
      assert.ok(def, `${id} muss im Registry sein`);
    }
  });
});

// Suppress unused warning
void dslMod;
