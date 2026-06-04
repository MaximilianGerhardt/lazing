/**
 * FSM-Verifier-Tests (Welle 3b, 2026-05-03).
 *
 * Run: `pnpm exec tsx --test lib/workflows/__tests__/fsm-verifier.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { verifyFsm } from '../fsm-verifier';
import type { WorkflowDefinition, WorkflowState } from '../dsl';
import { devSprintWorkflow } from '../definitions/dev-sprint';
import { fieldMeasurementWorkflow } from '../definitions/field-measurement';
import { legalBriefWorkflow } from '../definitions/legal-brief';
import { designGateFlowWorkflow } from '../definitions/design-gate-flow';
import { legalCorrespondenceWorkflow } from '../definitions/legal-correspondence';

describe('verifyFsm', () => {
  it('dev-sprint passes (no findings)', () => {
    const r = verifyFsm(devSprintWorkflow);
    assert.equal(r.hasFindings, false, JSON.stringify(r));
    assert.equal(r.unreachable.length, 0);
    assert.equal(r.deadlocks.length, 0);
  });

  it('field-measurement passes', () => {
    const r = verifyFsm(fieldMeasurementWorkflow);
    assert.equal(r.hasFindings, false, JSON.stringify(r));
  });

  it('legal-brief passes', () => {
    const r = verifyFsm(legalBriefWorkflow);
    assert.equal(r.hasFindings, false, JSON.stringify(r));
  });

  it('design-gate-flow passes', () => {
    const r = verifyFsm(designGateFlowWorkflow);
    assert.equal(r.hasFindings, false, JSON.stringify(r));
  });

  it('legal-correspondence passes', () => {
    const r = verifyFsm(legalCorrespondenceWorkflow);
    assert.equal(r.hasFindings, false, JSON.stringify(r));
  });

  it('synthetic deadlock workflow → flagged', () => {
    const states: ReadonlyArray<WorkflowState> = [
      {
        id: 'a',
        label: 'A',
        llmSlot: 'none',
        skillBinding: null,
        preConditions: [],
        postConditions: [],
        transitions: [{ to: 'b', label: 'go-b' }],
        manualOverride: 'allow',
      },
      {
        id: 'b',
        label: 'B (deadlock — no outgoing)',
        llmSlot: 'none',
        skillBinding: null,
        preConditions: [],
        postConditions: [],
        transitions: [], // ← deadlock
        manualOverride: 'allow',
      },
    ];
    const def: WorkflowDefinition = {
      id: 'dev-sprint',
      version: 'v1',
      label: 'synthetic',
      description: 'test',
      initialState: 'a',
      states,
      triggerHints: [],
    };
    const r = verifyFsm(def);
    assert.equal(r.hasFindings, true);
    assert.deepEqual(r.deadlocks, ['b']);
  });

  it('synthetic unreachable-state workflow → flagged', () => {
    const states: ReadonlyArray<WorkflowState> = [
      {
        id: 'a',
        label: 'A',
        llmSlot: 'none',
        skillBinding: null,
        preConditions: [],
        postConditions: [],
        transitions: [{ to: '__terminal__', label: 'done' }],
        manualOverride: 'allow',
      },
      {
        id: 'orphan',
        label: 'orphan (unreachable)',
        llmSlot: 'none',
        skillBinding: null,
        preConditions: [],
        postConditions: [],
        transitions: [{ to: '__terminal__', label: 'done' }],
        manualOverride: 'allow',
      },
    ];
    const def: WorkflowDefinition = {
      id: 'dev-sprint',
      version: 'v1',
      label: 'synthetic',
      description: 'test',
      initialState: 'a',
      states,
      triggerHints: [],
    };
    const r = verifyFsm(def);
    assert.equal(r.hasFindings, true);
    assert.deepEqual(r.unreachable, ['orphan']);
  });

  it('synthetic race-condition workflow → flagged', () => {
    const sharedSchema = z.object({ result: z.string() });
    const states: ReadonlyArray<WorkflowState> = [
      {
        id: 'fork',
        label: 'fork',
        llmSlot: 'none',
        skillBinding: null,
        preConditions: [],
        postConditions: [],
        transitions: [
          { to: 'pa', label: 'parallel-a' },
          { to: 'pb', label: 'parallel-b' },
        ],
        manualOverride: 'allow',
      },
      {
        id: 'pa',
        label: 'parallel-a',
        llmSlot: 'free-inference',
        skillBinding: null,
        outputSchema: sharedSchema,
        preConditions: [],
        postConditions: [],
        transitions: [{ to: '__terminal__', label: 'done' }],
        manualOverride: 'allow',
      },
      {
        id: 'pb',
        label: 'parallel-b',
        llmSlot: 'free-inference',
        skillBinding: null,
        outputSchema: sharedSchema,
        preConditions: [],
        postConditions: [],
        transitions: [{ to: '__terminal__', label: 'done' }],
        manualOverride: 'allow',
      },
    ];
    const def: WorkflowDefinition = {
      id: 'dev-sprint',
      version: 'v1',
      label: 'synthetic',
      description: 'test',
      initialState: 'fork',
      states,
      triggerHints: [],
    };
    const r = verifyFsm(def);
    assert.equal(r.hasFindings, true);
    assert.equal(r.raceConditions.length, 1);
    assert.equal(r.raceConditions[0].sharedKey, 'result');
  });
});
