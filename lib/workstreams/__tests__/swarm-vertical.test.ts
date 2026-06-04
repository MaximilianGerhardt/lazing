// V1 ship-gate — recursive-plan + critic-loop convergence smoke.
//
// BACKPORT-03 (2026-05-23). Tests the full top-of-stack flow without
// touching the DB substrate:
//
//   1. Operator intent → matchTemplate (deterministic).
//   2. proposeRecursivePlan with depth-1 eager expansion.
//   3. runWalker drives every coder/architect step through the critic
//      loop (INV-17).
//   4. Mixed verdict sequence — pass, conditional+fix, then pass —
//      validates the FSM converges + the iteration cap doesn't trigger
//      when the loop closes inside 2 fix-iterations.
//   5. Walker yields the expected event sequence.

import { describe, expect, it } from 'vitest';

import { matchTemplate, templateToProposedPlan } from '@/lib/plan-first/templates';
import {
  MAX_SUBPLAN_DEPTH,
  proposeRecursivePlan,
} from '@/lib/plan-first/recursive-plan';
import { runWalker, type WalkerEvent } from '@/lib/critic-loop/walker';
import type {
  CriticComment,
  CriticRepo,
  CriticRoundInsert,
  CriticRoundRow,
  CriticVerdict,
} from '@/lib/critic-loop/types';
import type { PlanStep } from '@/lib/plan-first/orchestrate-plan';

function makeInMemoryRepo(): CriticRepo & { readonly rows: CriticRoundRow[] } {
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
    markSuperseded() {
      /* noop in test */
    },
    listRoundsForStep(planStepId: string) {
      return rows.filter((r) => r.planStepId === planStepId);
    },
  };
}

describe('V1 ship-gate — recursive plan + critic-loop convergence', () => {
  it('template selection is deterministic (N6)', () => {
    const t = matchTemplate('fix the auth regression in sign-in');
    expect(t?.id).toBe('bug-fix');
  });

  it('proposeRecursivePlan eagerly expands depth-1 for architect/coder steps', async () => {
    const intent = 'implementiere new dashboard widget mit critic-loop';
    let idCounter = 0;
    const mintId = (): string => {
      idCounter += 1;
      return `ID-${idCounter}`;
    };
    const recursive = await proposeRecursivePlan(intent, {
      callEngine: async () =>
        JSON.stringify({
          estimatedComplexity: 'L',
          steps: [
            {
              index: 1,
              title: 'design widget',
              rationale: 'sketch the architecture and interfaces',
              subagentRole: 'architect',
            },
          ],
        }),
      mintId,
      now: () => 1_700_000_000_000,
      cascadeMode: 'cascade',
    });
    expect(recursive.maxDepth).toBe(MAX_SUBPLAN_DEPTH);
    // template matched feature-implement (7 root steps)
    expect(recursive.root.plan.steps.length).toBe(7);
    // Children populated for steps with subplanTrigger active
    expect(recursive.root.children.size).toBeGreaterThan(0);
  });

  it('walker converges on mixed pass/conditional/pass verdict sequence', async () => {
    // Hand-build a 3-step plan: coder, tester, reviewer (one of each gate-type).
    const rootPlan = {
      id: 'PLAN-1',
      originalIntent: 'fix the auth regression',
      estimatedComplexity: 'M' as const,
      proposedAt: 1_700_000_000_000,
      steps: [
        {
          id: 'STEP-1',
          index: 1,
          title: 'Apply the fix',
          rationale: 'small surgical change in sign-in',
          subagentRole: 'coder',
        } satisfies PlanStep,
        {
          id: 'STEP-2',
          index: 2,
          title: 'Add regression test',
          rationale: 'pin behaviour with a failing-test-first commit',
          subagentRole: 'tester',
        } satisfies PlanStep,
        {
          id: 'STEP-3',
          index: 3,
          title: 'Review the diff',
          rationale: 'reviewer checks for unintended scope',
          subagentRole: 'reviewer',
        } satisfies PlanStep,
      ],
    };
    const recursive = {
      root: {
        id: 'NODE-ROOT',
        step: null,
        plan: rootPlan,
        depth: 0,
        cascadeMode: 'cascade' as const,
        awaitingApproval: false,
        children: new Map(),
      },
      cascadeMode: 'cascade' as const,
      maxDepth: MAX_SUBPLAN_DEPTH,
    };

    const repo = makeInMemoryRepo();
    const events: WalkerEvent[] = [];

    // First critic call returns conditional (forces 1 fix-iter); second
    // returns pass.
    let criticCall = 0;
    const verdicts: CriticVerdict[] = ['conditional', 'pass'];

    const it = runWalker({
      plan: recursive,
      workstreamId: 'WS-1',
      hooks: {
        runStep: async () => ({ diff: '// diff body' }),
        proposeSubplan: async () => null,
        runCritic: async (
          _step,
          _iter,
        ): Promise<{ verdict: CriticVerdict; comments: readonly CriticComment[] }> => {
          const verdict = verdicts[criticCall] ?? 'pass';
          criticCall += 1;
          return { verdict, comments: [] };
        },
        repo,
        writeUserOverride: () => {
          /* noop */
        },
        cascadeMode: 'cascade',
      },
    });

    for await (const e of it) events.push(e);

    // 3 step-start events (one per step)
    const stepStarts = events.filter((e) => e.kind === 'step-start');
    expect(stepStarts.length).toBeGreaterThanOrEqual(3);

    // 3 step-finished events (one per step's final transition)
    const stepFinishes = events.filter((e) => e.kind === 'step-finished');
    expect(stepFinishes.length).toBe(3);

    // Step 1 (coder) traversed critic gate twice (one conditional, one pass)
    const criticVerdicts = events
      .filter((e) => e.kind === 'critic-verdict')
      .map((e) => (e as { verdict: CriticVerdict }).verdict);
    expect(criticVerdicts).toEqual(['conditional', 'pass']);

    // Step 2 + 3 (tester/reviewer) skipped critic-gate entirely (INV-17)
    const finishesByStep = new Map<string, number>();
    for (const e of stepFinishes) {
      const id = (e as { stepId: string }).stepId;
      finishesByStep.set(id, (finishesByStep.get(id) ?? 0) + 1);
    }
    expect(finishesByStep.get('STEP-2')).toBe(1);
    expect(finishesByStep.get('STEP-3')).toBe(1);

    // Exactly 2 critic rounds were persisted for STEP-1
    expect(repo.rows.filter((r) => r.planStepId === 'STEP-1')).toHaveLength(2);
    // ZERO critic rounds for tester / reviewer steps (INV-17)
    expect(repo.rows.filter((r) => r.planStepId === 'STEP-2')).toHaveLength(0);
    expect(repo.rows.filter((r) => r.planStepId === 'STEP-3')).toHaveLength(0);

    // INV-19 — every persisted critic round inherits the coder lane coord
    for (const r of repo.rows) {
      expect(r.coordKey).toBe('WS-1/plan-step:STEP-1');
    }
  });

  it('walker escalates after MAX_CRITIC_FIX_ITERATIONS (INV-16)', async () => {
    const rootPlan = {
      id: 'PLAN-2',
      originalIntent: 'feature implementation with stubborn critic',
      estimatedComplexity: 'L' as const,
      proposedAt: 1_700_000_000_000,
      steps: [
        {
          id: 'STEP-A',
          index: 1,
          title: 'Implement core',
          rationale: 'land the load-bearing code',
          subagentRole: 'coder',
        } satisfies PlanStep,
      ],
    };
    const recursive = {
      root: {
        id: 'NODE-ROOT-2',
        step: null,
        plan: rootPlan,
        depth: 0,
        cascadeMode: 'cascade' as const,
        awaitingApproval: false,
        children: new Map(),
      },
      cascadeMode: 'cascade' as const,
      maxDepth: MAX_SUBPLAN_DEPTH,
    };

    const repo = makeInMemoryRepo();
    const events: WalkerEvent[] = [];
    const it = runWalker({
      plan: recursive,
      workstreamId: 'WS-2',
      hooks: {
        runStep: async () => ({ diff: 'noop' }),
        proposeSubplan: async () => null,
        runCritic: async () => ({ verdict: 'conditional', comments: [] }),
        repo,
        writeUserOverride: () => {
          /* noop */
        },
        cascadeMode: 'cascade',
      },
    });
    for await (const e of it) events.push(e);

    // INV-16 — caps at MAX_CRITIC_FIX_ITERATIONS=2, so iter=0,1,2 → 3 critic rounds
    // before escalation
    expect(repo.rows.length).toBe(3);
    expect(events.some((e) => e.kind === 'escalated')).toBe(true);
  });
});
