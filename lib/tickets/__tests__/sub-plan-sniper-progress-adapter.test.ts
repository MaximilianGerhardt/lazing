/**
 * sniperToStages + inferSubStatus Tests (Sub-Plan 5 Welle 2, 2026-05-01).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  inferSubStatus,
  sniperToStages,
} from '../sub-plan-sniper-progress-adapter';

describe('inferSubStatus', () => {
  it('closed=true → done', () => {
    assert.equal(inferSubStatus({ id: 's1', closed: true }), 'done');
  });

  it('aborted/failed/error/cancelled → failed', () => {
    for (const ws of ['aborted', 'failed', 'error', 'cancelled']) {
      assert.equal(
        inferSubStatus({ id: 's', closed: false, workflowState: ws }),
        'failed',
        `ws=${ws}`,
      );
    }
  });

  it('skipped/irrelevant/merged → skipped', () => {
    for (const ws of ['skipped', 'irrelevant', 'merged']) {
      assert.equal(
        inferSubStatus({ id: 's', closed: false, workflowState: ws }),
        'skipped',
        `ws=${ws}`,
      );
    }
  });

  it('running/in-progress/dispatching → running', () => {
    for (const ws of ['running', 'in-progress', 'in_progress', 'dispatching']) {
      assert.equal(
        inferSubStatus({ id: 's', closed: false, workflowState: ws }),
        'running',
        `ws=${ws}`,
      );
    }
  });

  it('pending/queued/null → pending', () => {
    assert.equal(inferSubStatus({ id: 's', closed: false }), 'pending');
    assert.equal(
      inferSubStatus({ id: 's', closed: false, workflowState: 'pending' }),
      'pending',
    );
    assert.equal(
      inferSubStatus({ id: 's', closed: false, workflowState: 'queued' }),
      'pending',
    );
  });

  it('done/completed/closed-string + closed=false → done', () => {
    assert.equal(
      inferSubStatus({ id: 's', closed: false, workflowState: 'done' }),
      'done',
    );
    assert.equal(
      inferSubStatus({ id: 's', closed: false, workflowState: 'completed' }),
      'done',
    );
  });

  it('unbekannter State → pending (defensive)', () => {
    assert.equal(
      inferSubStatus({ id: 's', closed: false, workflowState: 'asd' }),
      'pending',
    );
  });

  it('case-insensitive', () => {
    assert.equal(
      inferSubStatus({ id: 's', closed: false, workflowState: 'RUNNING' }),
      'running',
    );
  });
});

describe('sniperToStages', () => {
  it('5 Subs → 5 Stages mit korrektem Status', () => {
    const stages = sniperToStages({
      masterTicketId: 'm1',
      subs: [
        { id: 's1', title: 'Build', closed: true },
        { id: 's2', title: 'Test', closed: false, workflowState: 'running' },
        { id: 's3', title: 'Deploy', closed: false, workflowState: 'pending' },
        { id: 's4', title: 'Smoke', closed: false, workflowState: 'failed' },
        { id: 's5', title: 'Cleanup', closed: false, workflowState: 'skipped' },
      ],
    });
    assert.equal(stages.length, 5);
    assert.equal(stages[0]!.status, 'done');
    assert.equal(stages[1]!.status, 'running');
    assert.equal(stages[2]!.status, 'pending');
    assert.equal(stages[3]!.status, 'failed');
    assert.equal(stages[4]!.status, 'skipped');
  });

  it('IDs sind eindeutig + enthalten masterTicketId', () => {
    const stages = sniperToStages({
      masterTicketId: 'mABC',
      subs: [{ id: 's1', closed: true }],
    });
    assert.match(stages[0]!.id, /sniper::mABC::s1/);
  });

  it('fallback-Label wenn title leer', () => {
    const stages = sniperToStages({
      masterTicketId: 'm1',
      subs: [{ id: 'abcdef1234567890', closed: false }],
    });
    assert.match(stages[0]!.label, /Sub /);
  });

  it('subtitle = workflowState wenn nicht closed', () => {
    const stages = sniperToStages({
      masterTicketId: 'm1',
      subs: [{ id: 's1', closed: false, workflowState: 'running' }],
    });
    assert.equal(stages[0]!.subtitle, 'running');
  });

  it('kein subtitle wenn closed', () => {
    const stages = sniperToStages({
      masterTicketId: 'm1',
      subs: [{ id: 's1', closed: true, workflowState: 'closed' }],
    });
    assert.equal(stages[0]!.subtitle, undefined);
  });
});
