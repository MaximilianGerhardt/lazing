/**
 * Tests fuer Welle 2 (Sub-Plan Auto-Swarm Bug-Fix · 2026-05-03):
 * Pipeline-Integration der 3-Tier-Roaster (Plan + Critic + Fix).
 *
 * Run: `pnpm exec vitest run lib/agents/__tests__/bug-fix-pipeline-swarm.test.ts`
 *
 * Cases:
 *   1. spawnPlanRoaster — happy path, alle 3 Tiers liefern, Konsens-Plan
 *   2. spawnPlanRoaster — Opus failed, Sonnet+Haiku gewinnen mit Mehrheit
 *   3. spawnPlanRoaster — alle 3 failed → Fallback synthesizeFixPlan
 *   4. spawnCriticSwarm — 2/3 APPROVED → allow:true
 *   5. spawnCriticSwarm — 2/3 BLOCKED → allow:false
 *   6. spawnCriticSwarm — 1 Tier wirft → wird als BLOCKED gezählt
 *   7. spawnFixRoaster — Opus liefert → tier=opus, fallback=false
 *   8. spawnFixRoaster — Opus failed, Sonnet liefert → tier=sonnet, fallback=true
 *   9. spawnFixRoaster — alle 3 failed → throws
 *  10. Pipeline-Integration: spawnPlan+spawnCritic+spawnFix gewired → finalPhase=done
 *  11. Pipeline-Integration: Critic-Swarm BLOCKED, dann APPROVED → 1 Re-Plan, done
 *  12. Pipeline-Integration: Critic-Swarm permanent BLOCKED → aborted nach 1 Re-Plan
 */

import { describe, it, expect } from 'vitest';

import {
  spawnPlanRoaster,
  spawnCriticSwarm,
  spawnFixRoaster,
  aggregatePlans,
  type PlanRoasterOutput,
  type PlanSpawnFn,
  type CriticSpawnFn,
  type FixSpawnFn,
} from '../bug-fix-roasters';
import {
  runBugFixPipeline,
  type PipelineDeps,
  type RunBugFixPipelineInput,
  type SweepResult,
  type VerifyResult,
} from '../bug-fix-pipeline';
import type { FixPlan, Hypothesis } from '../bug-hypothesis';

// --- Test Helpers -----------------------------------------------------------

function mkHyp(p: Partial<Hypothesis>): Hypothesis {
  return {
    perspective: 'syntactic-perspective',
    summary: 'mock',
    files: [{ file: 'src/a.ts' }],
    confidence: 0.7,
    raw: '',
    ...p,
  };
}

function mkPlan(p: Partial<FixPlan> = {}): FixPlan {
  return {
    winningHypothesis: mkHyp({}),
    rankedHypotheses: [{ hyp: mkHyp({}), score: 0.7 }],
    fixApproach: 'fix it',
    scopeFiles: [{ file: 'src/a.ts' }],
    planQuality: 'strong',
    ...p,
  };
}

const BUG_PROMPT =
  'TypeError: Cannot read properties of undefined\n  at foo (a.ts:42:18)';

function bugInput(over: Partial<RunBugFixPipelineInput> = {}): RunBugFixPipelineInput {
  return {
    workspaceId: 'ws-1',
    workstreamId: 'WS-1',
    parentTicketId: 'TIK-1',
    workspacePath: '/tmp/mock',
    prompt: BUG_PROMPT,
    ...over,
  };
}

function passedVerify(): VerifyResult {
  return {
    passed: true,
    steps: [
      { name: 'tsc', passed: true },
      { name: 'vitest', passed: true },
    ],
  };
}

function emptySweep(): SweepResult {
  return {
    patternMatches: [],
    callers: [],
    affectedTests: [],
    suggestedNewTests: [],
    raw: 'mock',
  };
}

function makeDepsWithSwarm(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  let nowCounter = 1_000_000;
  return {
    readCodeContext: async () => 'mock-context',
    spawnHypothesis: async ({ perspective }) =>
      mkHyp({ perspective, summary: `${perspective} hypothesis` }),
    runCriticRoast: async () => ({
      verdict: 'APPROVED',
      findings: [],
      raw: 'fallback-not-used',
    }),
    runPatternSweep: async () => emptySweep(),
    applyFix: async () => ({ commitSha: 'fallback0', summary: 'solo fallback' }),
    verifyFix: async () => passedVerify(),
    writeAudit: async () => undefined,
    now: () => nowCounter++,
    ...overrides,
  };
}

// --- spawnPlanRoaster ------------------------------------------------------

describe('spawnPlanRoaster', () => {
  it('happy path: alle 3 Tiers liefern → Konsens-Plan', async () => {
    const calls: string[] = [];
    const spawn: PlanSpawnFn = async ({ tier, hypotheses }) => {
      calls.push(tier);
      return {
        tier,
        plan: mkPlan({
          winningHypothesis: mkHyp({
            perspective: 'syntactic-perspective',
            summary: `${tier}-plan`,
          }),
        }),
        confidence: 0.8,
      };
    };
    const plan = await spawnPlanRoaster({
      workspaceId: 'ws-1',
      workstreamId: 'WS-1',
      hypotheses: [mkHyp({})],
      spawn,
    });
    // Alle 3 parallel gerufen
    expect(calls.sort()).toEqual(['haiku', 'opus', 'sonnet']);
    expect(plan.planQuality).toBe('strong');
    // Roaster-Konsens-Header in fixApproach
    expect(plan.fixApproach).toMatch(/Roaster-Konsens/);
  });

  it('Opus failed, Sonnet+Haiku gewinnen mit Mehrheit', async () => {
    const spawn: PlanSpawnFn = async ({ tier }) => {
      if (tier === 'opus') throw new Error('opus rate-limit');
      return {
        tier,
        plan: mkPlan({
          winningHypothesis: mkHyp({
            perspective: 'semantic-perspective',
            summary: `${tier}-plan`,
          }),
        }),
        confidence: 0.6,
      };
    };
    const plan = await spawnPlanRoaster({
      workspaceId: 'ws-1',
      workstreamId: 'WS-1',
      hypotheses: [mkHyp({})],
      spawn,
    });
    // 2/3 same perspective → strong
    expect(plan.planQuality).toBe('strong');
    expect(plan.winningHypothesis.perspective).toBe('semantic-perspective');
  });

  it('alle 3 Tiers failed → Fallback auf synthesizeFixPlan', async () => {
    const spawn: PlanSpawnFn = async () => {
      throw new Error('all dead');
    };
    const plan = await spawnPlanRoaster({
      workspaceId: 'ws-1',
      workstreamId: 'WS-1',
      hypotheses: [
        mkHyp({ perspective: 'syntactic-perspective', confidence: 0.5 }),
        mkHyp({ perspective: 'semantic-perspective', confidence: 0.4 }),
      ],
      spawn,
    });
    // Solo synthesizeFixPlan liefert klassischen Plan ohne Roaster-Header
    expect(plan.fixApproach).not.toMatch(/Roaster-Konsens/);
    expect(plan.winningHypothesis).toBeDefined();
  });

  it('aggregatePlans: 3-Way-Split → no-consensus + höchste Confidence gewinnt (Opus-only, equal weight)', () => {
    const plans: PlanRoasterOutput[] = [
      {
        tier: 'opus',
        plan: mkPlan({ winningHypothesis: mkHyp({ perspective: 'syntactic-perspective' }) }),
        confidence: 0.7,
      },
      {
        tier: 'sonnet',
        plan: mkPlan({ winningHypothesis: mkHyp({ perspective: 'semantic-perspective' }) }),
        confidence: 0.7,
      },
      {
        tier: 'haiku',
        plan: mkPlan({ winningHypothesis: mkHyp({ perspective: 'environmental-perspective' }) }),
        confidence: 0.99,
      },
    ];
    const merged = aggregatePlans(plans);
    expect(merged.planQuality).toBe('no-consensus');
    // Owner-Direktive Opus-only: alle drei Slots fahren real Opus 4.8 → gleiches
    // TIER_WEIGHT (1.0). Die Tier-Labels sind reine Slot-Namen, keine
    // Modell-Stärke mehr. Bei equal weight × confidence gewinnt schlicht die
    // höchste rohe Confidence: 0.99 (env) > 0.7 (syn) = 0.7 (sem).
    expect(merged.winningHypothesis.perspective).toBe('environmental-perspective');
  });
});

// --- spawnCriticSwarm ------------------------------------------------------

describe('spawnCriticSwarm', () => {
  it('2/3 APPROVED → allow:true', async () => {
    const spawn: CriticSpawnFn = async ({ tier }) => ({
      tier,
      verdict: tier === 'haiku' ? 'BLOCKED' : 'APPROVED',
      reason: `${tier}-says`,
    });
    const v = await spawnCriticSwarm({
      workspaceId: 'ws',
      workstreamId: 'WS',
      fixPlan: mkPlan(),
      spawn,
    });
    expect(v.allow).toBe(true);
    expect(v.tiers.filter((t) => t.verdict === 'APPROVED').length).toBe(2);
  });

  it('2/3 BLOCKED → allow:false', async () => {
    const spawn: CriticSpawnFn = async ({ tier }) => ({
      tier,
      verdict: tier === 'opus' ? 'APPROVED' : 'BLOCKED',
      reason: `${tier}-says`,
    });
    const v = await spawnCriticSwarm({
      workspaceId: 'ws',
      workstreamId: 'WS',
      fixPlan: mkPlan(),
      spawn,
    });
    expect(v.allow).toBe(false);
    expect(v.summary).toMatch(/BLOCKED/);
  });

  it('1 Tier crasht → als BLOCKED gezählt (defensive)', async () => {
    const spawn: CriticSpawnFn = async ({ tier }) => {
      if (tier === 'opus') throw new Error('crash');
      return { tier, verdict: 'APPROVED', reason: `${tier}-ok` };
    };
    const v = await spawnCriticSwarm({
      workspaceId: 'ws',
      workstreamId: 'WS',
      fixPlan: mkPlan(),
      spawn,
    });
    // 2 APPROVED + 1 BLOCKED-by-crash → 2/3 APPROVED → allow:true
    expect(v.allow).toBe(true);
    const opusTier = v.tiers.find((t) => t.tier === 'opus')!;
    expect(opusTier.verdict).toBe('BLOCKED');
    expect(opusTier.reason).toMatch(/fehlgeschlagen/);
  });
});

// --- spawnFixRoaster -------------------------------------------------------

describe('spawnFixRoaster', () => {
  it('Opus liefert → tier=opus, fallback=false', async () => {
    const spawn: FixSpawnFn = async ({ tier }) => ({
      tier,
      commitSha: `${tier}-sha`,
      summary: `${tier}-fix`,
      fallback: false,
    });
    const r = await spawnFixRoaster({
      workspaceId: 'ws',
      workstreamId: 'WS',
      workspacePath: '/tmp',
      bugDescription: 'bug',
      fixPlan: mkPlan(),
      spawn,
    });
    expect(r.tier).toBe('opus');
    expect(r.fallback).toBe(false);
    expect(r.commitSha).toBe('opus-sha');
  });

  it('Opus failed, Sonnet liefert → tier=sonnet, fallback=true', async () => {
    const spawn: FixSpawnFn = async ({ tier }) => {
      if (tier === 'opus') throw new Error('opus down');
      return {
        tier,
        commitSha: `${tier}-sha`,
        summary: `${tier}-fix`,
        fallback: false,
      };
    };
    const r = await spawnFixRoaster({
      workspaceId: 'ws',
      workstreamId: 'WS',
      workspacePath: '/tmp',
      bugDescription: 'bug',
      fixPlan: mkPlan(),
      spawn,
    });
    expect(r.tier).toBe('sonnet');
    expect(r.fallback).toBe(true);
  });

  it('alle 3 failed → throws', async () => {
    const spawn: FixSpawnFn = async () => {
      throw new Error('all dead');
    };
    await expect(
      spawnFixRoaster({
        workspaceId: 'ws',
        workstreamId: 'WS',
        workspacePath: '/tmp',
        bugDescription: 'bug',
        fixPlan: mkPlan(),
        spawn,
      }),
    ).rejects.toThrow(/alle 3 Tiers failed/);
  });
});

// --- Pipeline-Integration --------------------------------------------------

describe('runBugFixPipeline mit Swarm-Mode', () => {
  it('alle 3 Roaster-Phases gewired → finalPhase=done', async () => {
    const planSpawn: PlanSpawnFn = async ({ tier }) => ({
      tier,
      plan: mkPlan({
        winningHypothesis: mkHyp({
          perspective: 'syntactic-perspective',
          summary: `${tier}-plan`,
        }),
      }),
      confidence: 0.85,
    });
    const criticSpawn: CriticSpawnFn = async ({ tier }) => ({
      tier,
      verdict: 'APPROVED',
      reason: `${tier}-ok`,
    });
    const fixSpawn: FixSpawnFn = async ({ tier }) => ({
      tier,
      commitSha: `${tier}-sha`,
      summary: `${tier}-applied`,
      fallback: false,
    });
    const result = await runBugFixPipeline(
      makeDepsWithSwarm({
        spawnPlan: planSpawn,
        spawnCritic: criticSpawn,
        spawnFix: fixSpawn,
      }),
      bugInput(),
    );
    expect(result.finalPhase).toBe('done');
    expect(result.criticSwarm).toBeDefined();
    expect(result.criticSwarm!.allow).toBe(true);
    expect(result.criticSwarm!.tiers.length).toBe(3);
    expect(result.fixPlan?.fixApproach).toMatch(/Roaster-Konsens/);
  });

  it('Swarm-Critic BLOCKED, dann APPROVED → 1 Re-Plan, done', async () => {
    let criticCall = 0;
    const planSpawn: PlanSpawnFn = async ({ tier }) => ({
      tier,
      plan: mkPlan({
        winningHypothesis: mkHyp({
          perspective: 'syntactic-perspective',
          summary: `${tier}-plan`,
        }),
      }),
      confidence: 0.8,
    });
    const criticSpawn: CriticSpawnFn = async ({ tier }) => {
      criticCall++;
      // Erste Welle (call 1-3): 2/3 BLOCKED → BLOCKED.
      // Zweite Welle (call 4-6): alle APPROVED → APPROVED.
      if (criticCall <= 3) {
        return {
          tier,
          verdict: tier === 'haiku' ? 'APPROVED' : 'BLOCKED',
          reason: `${tier}-r1`,
        };
      }
      return { tier, verdict: 'APPROVED', reason: `${tier}-r2` };
    };
    const fixSpawn: FixSpawnFn = async ({ tier }) => ({
      tier,
      commitSha: `${tier}-sha`,
      summary: 'applied',
      fallback: false,
    });
    const result = await runBugFixPipeline(
      makeDepsWithSwarm({
        spawnPlan: planSpawn,
        spawnCritic: criticSpawn,
        spawnFix: fixSpawn,
      }),
      bugInput(),
    );
    expect(result.finalPhase).toBe('done');
    expect(result.replanCount).toBe(1);
    // 2 Critic-Wellen × 3 Tiers = 6 Calls.
    expect(criticCall).toBe(6);
  });

  it('Swarm-Critic permanent BLOCKED → aborted nach 1 Re-Plan (max in swarm-mode)', async () => {
    const planSpawn: PlanSpawnFn = async ({ tier }) => ({
      tier,
      plan: mkPlan({
        winningHypothesis: mkHyp({ perspective: 'syntactic-perspective' }),
      }),
      confidence: 0.8,
    });
    const criticSpawn: CriticSpawnFn = async ({ tier }) => ({
      tier,
      verdict: 'BLOCKED',
      reason: `${tier}-always-blocked`,
    });
    const fixSpawn: FixSpawnFn = async ({ tier }) => ({
      tier,
      commitSha: `${tier}-sha`,
      summary: 'unreachable',
      fallback: false,
    });
    const result = await runBugFixPipeline(
      makeDepsWithSwarm({
        spawnPlan: planSpawn,
        spawnCritic: criticSpawn,
        spawnFix: fixSpawn,
      }),
      bugInput(),
    );
    expect(result.finalPhase).toBe('aborted');
    // In swarm-mode default max-replan = 1 → 0 (initial) → 1 (replan) → 2 (over)
    expect(result.replanCount).toBe(2);
    expect(result.criticSwarm?.allow).toBe(false);
  });
});
