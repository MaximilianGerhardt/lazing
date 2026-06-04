// Critic-Loop FSM tests — BACKPORT-03 (2026-05-23).
//
// Hardens INV-16/17/18/19 in code-level tests independent of any DB
// substrate. The repo is mocked via an in-memory fake.

import { describe, expect, it } from 'vitest';

import {
  applyOperatorOverride,
  cancelLoop,
  MAX_CRITIC_FIX_ITERATIONS,
  onFixIterStart,
  onLaneFinished,
  planStepStatusFromState,
  requireCritic,
  statusFromState,
  writeCriticRoundForStep,
  type CriticLoopContext,
  type CriticLoopState,
} from '../critic-loop';
import type {
  CriticComment,
  CriticRepo,
  CriticRoundInsert,
  CriticRoundRow,
} from '../types';

function makeInMemoryRepo(): CriticRepo & {
  readonly rows: CriticRoundRow[];
} {
  const rows: CriticRoundRow[] = [];
  return {
    rows,
    writeCriticRound(input: CriticRoundInsert) {
      const row: CriticRoundRow = {
        id: `CRIT-${rows.length + 1}`,
        planStepId: input.planStepId,
        iteration: input.iteration,
        verdict: input.verdict,
        commentsJson: JSON.stringify(input.comments),
        criticRole: input.criticRole,
        coordKey: input.coordKey,
        workstreamId: input.workstreamId,
        contentHash: `hash:${rows.length + 1}`,
        supersededAt: null,
        createdAt: 1_700_000_000_000 + rows.length,
      };
      rows.push(row);
      return { row };
    },
    markSuperseded(planStepId, upToIteration, now) {
      const ts = now ?? Date.now();
      for (const r of rows) {
        if (r.planStepId === planStepId && r.iteration <= upToIteration) {
          (r as { supersededAt: number | null }).supersededAt = ts;
        }
      }
    },
    listRoundsForStep(planStepId) {
      return rows
        .filter((r) => r.planStepId === planStepId)
        .sort((a, b) => a.iteration - b.iteration);
    },
  };
}

const COMMENT: CriticComment = {
  role: 'critic',
  text: 'tighten the edge case',
  severity: 'minor',
};

function baseCtx(role: CriticLoopContext['role'] = 'coder'): CriticLoopContext {
  return {
    stepId: 'STEP-1',
    coordKey: 'ws:main/plan-step:STEP-1',
    workstreamId: 'WS-1',
    role,
  };
}

describe('requireCritic — INV-17', () => {
  it('requires critic gate for coder and architect', () => {
    expect(requireCritic('coder')).toBe(true);
    expect(requireCritic('architect')).toBe(true);
  });
  it('skips critic gate for tester / reviewer / undefined', () => {
    expect(requireCritic('tester')).toBe(false);
    expect(requireCritic('reviewer')).toBe(false);
    expect(requireCritic(undefined)).toBe(false);
  });
});

describe('onLaneFinished — INV-17', () => {
  it('coder lane → critic-pending', () => {
    const r = onLaneFinished(baseCtx('coder'), {
      kind: 'executing',
      iteration: 0,
    });
    expect(r.next.kind).toBe('critic-pending');
    expect(r.walkerHint).toBe('none');
  });
  it('tester lane skips critic-pending', () => {
    const r = onLaneFinished(baseCtx('tester'), {
      kind: 'executing',
      iteration: 0,
    });
    expect(r.next.kind).toBe('resolved');
    expect(r.walkerHint).toBe('proceed');
  });
});

describe('writeCriticRoundForStep — INV-16 + INV-19', () => {
  it('pass verdict → resolved + proceed', () => {
    const repo = makeInMemoryRepo();
    const ctx = baseCtx('coder');
    const state: CriticLoopState = { kind: 'critic-pending', iteration: 0 };
    const r = writeCriticRoundForStep(ctx, state, 'pass', [COMMENT], repo);
    expect(r.next.kind).toBe('resolved');
    expect(r.walkerHint).toBe('proceed');
    expect(repo.rows[0]?.coordKey).toBe(ctx.coordKey); // INV-19
  });

  it('conditional verdict → fix-pending + spawn-fix-iter', () => {
    const repo = makeInMemoryRepo();
    const ctx = baseCtx('coder');
    const state: CriticLoopState = { kind: 'critic-pending', iteration: 0 };
    const r = writeCriticRoundForStep(
      ctx,
      state,
      'conditional',
      [COMMENT],
      repo,
    );
    expect(r.next.kind).toBe('fix-pending');
    expect(r.walkerHint).toBe('spawn-fix-iter');
    if (r.next.kind === 'fix-pending') {
      expect(r.next.iteration).toBe(1);
    }
  });

  it('caps fix iterations at MAX_CRITIC_FIX_ITERATIONS (INV-16)', () => {
    const repo = makeInMemoryRepo();
    const ctx = baseCtx('coder');
    expect(MAX_CRITIC_FIX_ITERATIONS).toBe(2);

    // iter=0 → conditional → fix-pending (iter goes to 1)
    let r = writeCriticRoundForStep(
      ctx,
      { kind: 'critic-pending', iteration: 0 },
      'conditional',
      [COMMENT],
      repo,
    );
    expect(r.next.kind).toBe('fix-pending');

    // iter=1 → conditional → fix-pending (iter goes to 2)
    r = writeCriticRoundForStep(
      ctx,
      { kind: 'critic-pending', iteration: 1 },
      'conditional',
      [COMMENT],
      repo,
    );
    expect(r.next.kind).toBe('fix-pending');

    // iter=2 → conditional → MUST escalate (INV-16 cap)
    r = writeCriticRoundForStep(
      ctx,
      { kind: 'critic-pending', iteration: 2 },
      'conditional',
      [COMMENT],
      repo,
    );
    expect(r.next.kind).toBe('failed-escalated');
    expect(r.walkerHint).toBe('escalate');
  });

  it('fail verdict → failed-escalated + escalate', () => {
    const repo = makeInMemoryRepo();
    const ctx = baseCtx('coder');
    const r = writeCriticRoundForStep(
      ctx,
      { kind: 'critic-pending', iteration: 0 },
      'fail',
      [COMMENT],
      repo,
    );
    expect(r.next.kind).toBe('failed-escalated');
    expect(r.walkerHint).toBe('escalate');
  });

  it('rejects writes from non-critic-pending states', () => {
    const repo = makeInMemoryRepo();
    const ctx = baseCtx('coder');
    expect(() =>
      writeCriticRoundForStep(
        ctx,
        { kind: 'executing', iteration: 0 },
        'pass',
        [],
        repo,
      ),
    ).toThrow(/must be 'critic-pending'/);
  });

  it('INV-19 — critic row inherits coder-lane coordKey verbatim', () => {
    const repo = makeInMemoryRepo();
    const ctx = baseCtx('coder');
    writeCriticRoundForStep(
      ctx,
      { kind: 'critic-pending', iteration: 0 },
      'pass',
      [COMMENT],
      repo,
    );
    expect(repo.rows[0]?.coordKey).toBe(ctx.coordKey);
    expect(repo.rows[0]?.workstreamId).toBe(ctx.workstreamId);
  });
});

describe('onFixIterStart', () => {
  it('fix-pending → executing keeps iteration', () => {
    const next = onFixIterStart({
      kind: 'fix-pending',
      iteration: 1,
      lastVerdict: 'conditional',
    });
    expect(next.kind).toBe('executing');
    if (next.kind === 'executing') expect(next.iteration).toBe(1);
  });
  it('rejects non-fix-pending', () => {
    expect(() => onFixIterStart({ kind: 'pending' })).toThrow();
  });
});

describe('applyOperatorOverride — INV-18', () => {
  it('writes user_override_critic decision on failed-escalated', () => {
    const writes: Array<{
      actionId: string;
      actionLabel: string;
      workstreamId: string;
      coordKey: string;
    }> = [];
    const ctx = baseCtx('coder');
    const next = applyOperatorOverride({
      ctx,
      state: {
        kind: 'failed-escalated',
        iteration: 2,
        lastVerdict: 'fail',
      },
      note: 'operator approved — risk accepted (verbatim N1)',
      writeUserOverride: (a) => writes.push(a),
    });
    expect(next.kind).toBe('resolved');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.actionId).toBe('user_override_critic');
    expect(writes[0]?.actionLabel).toBe(
      'operator approved — risk accepted (verbatim N1)',
    );
    expect(writes[0]?.coordKey).toBe(ctx.coordKey); // INV-19 in override too
  });

  it('refuses override from non-failed-escalated state', () => {
    expect(() =>
      applyOperatorOverride({
        ctx: baseCtx('coder'),
        state: { kind: 'resolved', finalRoundId: null },
        note: 'no',
        writeUserOverride: () => {
          /* noop */
        },
      }),
    ).toThrow(/must be 'failed-escalated'/);
  });

  it('refuses override when workstreamId is null', () => {
    const ctx: CriticLoopContext = {
      stepId: 'STEP-1',
      coordKey: 'ws:main/plan-step:STEP-1',
      workstreamId: null,
      role: 'coder',
    };
    expect(() =>
      applyOperatorOverride({
        ctx,
        state: {
          kind: 'failed-escalated',
          iteration: 0,
          lastVerdict: 'fail',
        },
        note: 'no',
        writeUserOverride: () => {
          /* noop */
        },
      }),
    ).toThrow(/workstreamId is required/);
  });
});

describe('status projections', () => {
  it('statusFromState covers every state', () => {
    expect(statusFromState({ kind: 'pending' })).toBe('pending');
    expect(statusFromState({ kind: 'executing', iteration: 0 })).toBe('active');
    expect(statusFromState({ kind: 'executing', iteration: 1 })).toBe(
      'fix-iter-1',
    );
    expect(statusFromState({ kind: 'critic-pending', iteration: 0 })).toBe(
      'in-critic',
    );
    expect(
      statusFromState({
        kind: 'fix-pending',
        iteration: 2,
        lastVerdict: 'conditional',
      }),
    ).toBe('fix-iter-2');
    expect(
      statusFromState({
        kind: 'failed-escalated',
        iteration: 1,
        lastVerdict: 'fail',
      }),
    ).toBe('escalated');
    expect(statusFromState({ kind: 'resolved', finalRoundId: 'x' })).toBe(
      'done',
    );
    expect(statusFromState({ kind: 'cancelled' })).toBe('cancelled');
  });

  it('planStepStatusFromState normalises to the 4-value enum', () => {
    expect(planStepStatusFromState({ kind: 'pending' })).toBe('pending');
    expect(
      planStepStatusFromState({ kind: 'executing', iteration: 0 }),
    ).toBe('active');
    expect(
      planStepStatusFromState({ kind: 'critic-pending', iteration: 0 }),
    ).toBe('active');
    expect(planStepStatusFromState({ kind: 'resolved', finalRoundId: null })).toBe(
      'done',
    );
    expect(
      planStepStatusFromState({
        kind: 'failed-escalated',
        iteration: 0,
        lastVerdict: 'fail',
      }),
    ).toBe('failed');
    expect(planStepStatusFromState({ kind: 'cancelled' })).toBe('failed');
  });
});

describe('cancelLoop', () => {
  it('cancels non-terminal states', () => {
    expect(cancelLoop({ kind: 'pending' }).kind).toBe('cancelled');
    expect(
      cancelLoop({ kind: 'executing', iteration: 0 }).kind,
    ).toBe('cancelled');
  });
  it('does not re-cancel resolved/cancelled states', () => {
    const s: CriticLoopState = { kind: 'resolved', finalRoundId: null };
    expect(cancelLoop(s)).toBe(s);
    const c: CriticLoopState = { kind: 'cancelled' };
    expect(cancelLoop(c)).toBe(c);
  });
});
