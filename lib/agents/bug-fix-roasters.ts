/**
 * lib/agents/bug-fix-roasters.ts
 * --------------------------------
 * Wave 2 (Sub-Plan Auto-Swarm Bug-Fix · 2026-05-03)
 *
 * User frustration 2026-05-03 (verbatim):
 *   "Sonnet und Opus neigen dazu immer alles selber zu machen... gerade
 *    das Bug-fixing"
 *
 * Audit result: Bug-fix pipeline phase 3 (hypothesize) is parallelized,
 * but phase 4 (plan), phase 5 (critic) and phase 6 (fix) all ran
 * solo-inline. So no 3-tier roaster + majority vote is possible.
 *
 * Three roaster functions:
 *
 *   1. spawnPlanRoaster()    — Phase 4: 3 parallel plan spawns (Opus +
 *                              Sonnet + Haiku), synthesizer aggregates
 *                              via majority vote on the claim axis,
 *                              conflict tiebreaker = highest confidence.
 *
 *   2. spawnCriticSwarm()    — Phase 5: 3 parallel devil's-advocate
 *                              spawns. 2/3 APPROVED → allow:true. On
 *                              BLOCKED: 1x re-plan cycle (instead of
 *                              while-true).
 *
 *   3. spawnFixRoaster()     — Phase 6: Opus primary + Sonnet/Haiku as
 *                              backup via Promise.allSettled. So no
 *                              single point of failure on Opus rate
 *                              limit or crash.
 *
 * All three are pure-compose functions. Caller injects the spawn
 * functions so tests run without LLM calls.
 *
 * Wave 3c (`lib/agents/consensus-term-logic.ts`, commit fa32fdb) has
 * landed — deliberate separation of responsibility:
 *   - consensus-term-logic.ts: aggregates Term[][]  (claim/basis/confidence
 *     triples) into ConsensusGroup[] + conflict clusters + outliers. Pure
 *     symbolic-AI consensus formation.
 *   - bug-fix-roasters.ts:     aggregates FixPlan outputs with perspective +
 *     scope. Domain-specific, can later optionally be re-implemented
 *     term-based when roaster spawns deliver claim/basis/confidence
 *     directly instead of FixPlan.
 * The existing aggregatePlans() remains the primary aggregate for now —
 * future work: optionally layer term logic on top when spawn outputs
 * deliver claim/basis/confidence in a structured way.
 */

import type { TierModel } from './pricing';
import type { FixPlan, Hypothesis } from './bug-hypothesis';
import { synthesizeFixPlan } from './bug-hypothesis';

// --- Public Types -----------------------------------------------------------

export interface PlanRoasterOutput {
  tier: TierModel;
  plan: FixPlan;
  /** 0..1 — confidence of the individual tier spawn. */
  confidence: number;
  /** Raw output for audit. */
  raw?: string;
}

export interface CriticVerdictTier {
  tier: TierModel;
  /** APPROVED or BLOCKED. */
  verdict: 'APPROVED' | 'BLOCKED';
  /** Reason (1 sentence). */
  reason: string;
}

export interface CriticSwarmVerdict {
  /** True if 2/3 APPROVED. */
  allow: boolean;
  /** Individual verdicts of the 3 tiers (for audit + UI). */
  tiers: CriticVerdictTier[];
  /** Consolidated reason. */
  summary: string;
}

export interface FixRoasterOutput {
  /** Which tier made the fix. Opus is primary. */
  tier: TierModel;
  /** Commit SHA if successful. */
  commitSha?: string;
  /** Summary for UI. */
  summary: string;
  /** True if a fallback (sonnet/haiku) won instead of the primary (opus). */
  fallback: boolean;
  /** Raw output for audit. */
  raw?: string;
}

// --- Spawn function types (caller injects) ---------------------------------

export interface PlanSpawnInput {
  tier: TierModel;
  hypotheses: ReadonlyArray<Hypothesis>;
  workspaceId: string;
  workstreamId: string;
}

export type PlanSpawnFn = (input: PlanSpawnInput) => Promise<PlanRoasterOutput>;

export interface CriticSpawnInput {
  tier: TierModel;
  fixPlan: FixPlan;
  workspaceId: string;
  workstreamId: string;
}

export type CriticSpawnFn = (
  input: CriticSpawnInput,
) => Promise<CriticVerdictTier>;

export interface FixSpawnInput {
  tier: TierModel;
  fixPlan: FixPlan;
  workspaceId: string;
  workstreamId: string;
  workspacePath: string;
  bugDescription: string;
}

export type FixSpawnFn = (input: FixSpawnInput) => Promise<FixRoasterOutput>;

// --- Constants --------------------------------------------------------------

// Owner directive Opus-only (2026-05-29/30): ALL spawns actually run on Opus
// 4.8 (the injected spawn-fn resolves MODEL_NAMES[tier] → opus for every
// label). The three entries remain as DISTINCT redundancy slots
// (3 parallel Opus roasters via Promise.allSettled + map keying), NOT as a
// model axis. The labels 'sonnet'/'haiku' are pure slot names here — no
// slot ever runs a weaker model. Collapsing them to 'opus','opus','opus'
// would break the Map<TierModel,…> keying (1 instead of 3 slots).
const ALL_TIERS: ReadonlyArray<TierModel> = ['opus', 'sonnet', 'haiku'];

// --- Phase 4: spawnPlanRoaster ---------------------------------------------

export interface SpawnPlanRoasterInput {
  workspaceId: string;
  workstreamId: string;
  hypotheses: ReadonlyArray<Hypothesis>;
  spawn: PlanSpawnFn;
}

/**
 * Phase 4 (Plan) — 3-tier roaster instead of solo `synthesizeFixPlan(hypotheses)`.
 *
 * Strategy:
 *   1. 3 parallel spawns via Promise.allSettled (no spawn blocks the
 *      others).
 *   2. Aggregator (see `aggregatePlans`): majority vote on the
 *      `winningHypothesis.perspective` axis — the most frequent perspective
 *      wins. On conflict (all 3 different): plan with highest
 *      `confidence` wins.
 *   3. If all 3 spawns fail → fallback to solo `synthesizeFixPlan`
 *      with the existing hypotheses so the pipeline doesn't crash.
 *
 * Even if only 1 of 3 succeeds, its plan is used as output
 * — better-than-nothing.
 */
export async function spawnPlanRoaster(
  input: SpawnPlanRoasterInput,
): Promise<FixPlan> {
  const settled = await Promise.allSettled(
    ALL_TIERS.map((tier) =>
      input.spawn({
        tier,
        hypotheses: input.hypotheses,
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
      }),
    ),
  );

  const ok: PlanRoasterOutput[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled') ok.push(r.value);
  }

  if (ok.length === 0) {
    // All 3 failed → fallback to solo. Pipeline continues.
    if (input.hypotheses.length === 0) {
      throw new Error('spawnPlanRoaster: alle Spawns failed UND keine Hypothesen für Fallback');
    }
    return synthesizeFixPlan(input.hypotheses);
  }

  return aggregatePlans(ok);
}

/**
 * Plan aggregator (quadruple form):
 *   - Majority vote on the `winningHypothesis.perspective` axis.
 *   - On tie/3-way split: plan with highest `confidence` × tier weight wins.
 *   - Tier weight (heuristic, until Wave 3c arrives):
 *       opus=1.0, sonnet=0.85, haiku=0.7
 *   - scopeFiles are merged as the union of the 3 plans (dedupe by file).
 *   - planQuality:
 *       3/3 same perspective → 'strong'
 *       2/3 same perspective → 'strong' (slim majority suffices)
 *       3 different          → 'no-consensus'
 */
export function aggregatePlans(plans: ReadonlyArray<PlanRoasterOutput>): FixPlan {
  if (plans.length === 0) {
    throw new Error('aggregatePlans: empty plans');
  }
  if (plans.length === 1) {
    return plans[0]!.plan;
  }

  // Opus-only (owner directive): all three slots actually run Opus 4.8, hence
  // equal weighting (1.0). The earlier 1.0/0.85/0.7 tiering would have
  // artificially devalued two identically-strong Opus outputs — pointless under Opus-only.
  const TIER_WEIGHT: Record<TierModel, number> = {
    opus: 1.0,
    sonnet: 1.0,
    haiku: 1.0,
  };

  // Majority vote on perspective.
  const perspectiveCount = new Map<string, number>();
  for (const p of plans) {
    const key = p.plan.winningHypothesis.perspective;
    perspectiveCount.set(key, (perspectiveCount.get(key) ?? 0) + 1);
  }

  const sortedPerspectives = Array.from(perspectiveCount.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  const topCount = sortedPerspectives[0]![1];

  const winners = plans.filter(
    (p) => p.plan.winningHypothesis.perspective === sortedPerspectives[0]![0],
  );

  // On tie in the perspective vote (all 1x): highest confidence × tier weight.
  // Otherwise: from the majority plans the one with highest confidence × tier weight.
  const candidatePool = topCount === 1 ? plans : winners;

  const ranked = [...candidatePool].sort((a, b) => {
    const scoreA = a.confidence * TIER_WEIGHT[a.tier];
    const scoreB = b.confidence * TIER_WEIGHT[b.tier];
    return scoreB - scoreA;
  });

  const winning = ranked[0]!;

  // Scope union over all plans.
  const scopeMap = new Map<string, { file: string; line?: number }>();
  for (const p of plans) {
    for (const f of p.plan.scopeFiles) {
      if (!scopeMap.has(f.file)) scopeMap.set(f.file, f);
    }
  }

  // PlanQuality by majority consensus.
  let planQuality: FixPlan['planQuality'];
  if (topCount === plans.length) {
    planQuality = 'strong';
  } else if (topCount >= 2) {
    planQuality = 'strong';
  } else {
    planQuality = 'no-consensus';
  }

  return {
    ...winning.plan,
    scopeFiles: Array.from(scopeMap.values()),
    planQuality,
    fixApproach: buildAggregatedApproach(winning, plans, planQuality),
  };
}

function buildAggregatedApproach(
  winning: PlanRoasterOutput,
  all: ReadonlyArray<PlanRoasterOutput>,
  quality: FixPlan['planQuality'],
): string {
  const head =
    quality === 'strong'
      ? `Roaster-Konsens (${all.length} Tiers):`
      : `Roaster ohne Konsens (${all.length} Tiers, best-guess):`;
  return `${head} ${winning.plan.fixApproach} [winner-tier=${winning.tier}, conf=${winning.confidence.toFixed(2)}]`;
}

// --- Phase 5: spawnCriticSwarm ---------------------------------------------

export interface SpawnCriticSwarmInput {
  workspaceId: string;
  workstreamId: string;
  fixPlan: FixPlan;
  spawn: CriticSpawnFn;
}

/**
 * Phase 5 (Critic) — 3-tier devil's-advocate swarm instead of solo
 * `runCriticRoast()`. 2-of-3 majority rule.
 *
 * A failed tier counts as BLOCKED (defensive: if the critic crashes, better
 * to block conservatively than to pseudo-APPROVE).
 */
export async function spawnCriticSwarm(
  input: SpawnCriticSwarmInput,
): Promise<CriticSwarmVerdict> {
  const settled = await Promise.allSettled(
    ALL_TIERS.map((tier) =>
      input.spawn({
        tier,
        fixPlan: input.fixPlan,
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
      }),
    ),
  );

  const tiers: CriticVerdictTier[] = settled.map((r, i) => {
    const tier = ALL_TIERS[i]!;
    if (r.status === 'fulfilled') return r.value;
    return {
      tier,
      verdict: 'BLOCKED' as const,
      reason: `Critic-Spawn fehlgeschlagen: ${truncErr(r.reason)}`,
    };
  });

  const approvedCount = tiers.filter((t) => t.verdict === 'APPROVED').length;
  const blockedCount = tiers.length - approvedCount;
  const allow = approvedCount >= 2;

  const summary = allow
    ? `Critic-Swarm APPROVED (${approvedCount}/3 OK)`
    : `Critic-Swarm BLOCKED (${blockedCount}/3 BLOCKED · ${approvedCount}/3 OK)`;

  return { allow, tiers, summary };
}

// --- Phase 6: spawnFixRoaster ----------------------------------------------

export interface SpawnFixRoasterInput {
  workspaceId: string;
  workstreamId: string;
  workspacePath: string;
  bugDescription: string;
  fixPlan: FixPlan;
  spawn: FixSpawnFn;
}

/**
 * Phase 6 (Fix) — Opus primary + Sonnet/Haiku as backup via
 * `Promise.allSettled`.
 *
 * Strategy:
 *   - Start all 3 tiers in parallel.
 *   - Opus result if fulfilled → wins, fallback=false.
 *   - Otherwise Sonnet if fulfilled → wins, fallback=true.
 *   - Otherwise Haiku if fulfilled → wins, fallback=true.
 *   - All 3 failed → throw with aggregated error message.
 *
 * 9 parallel spawns per bug (3 plan + 3 critic + 3 fix) is acceptable on
 * the MAX plan. The TPM budget check should happen at spawn time (in the caller).
 */
export async function spawnFixRoaster(
  input: SpawnFixRoasterInput,
): Promise<FixRoasterOutput> {
  const settled = await Promise.allSettled(
    ALL_TIERS.map((tier) =>
      input.spawn({
        tier,
        fixPlan: input.fixPlan,
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        workspacePath: input.workspacePath,
        bugDescription: input.bugDescription,
      }),
    ),
  );

  const byTier = new Map<TierModel, PromiseSettledResult<FixRoasterOutput>>();
  ALL_TIERS.forEach((t, i) => byTier.set(t, settled[i]!));

  // Order: opus → sonnet → haiku.
  for (const tier of ALL_TIERS) {
    const r = byTier.get(tier)!;
    if (r.status === 'fulfilled') {
      const fallback = tier !== 'opus';
      return { ...r.value, fallback };
    }
  }

  // All 3 failed.
  const reasons = ALL_TIERS.map((t) => {
    const r = byTier.get(t)!;
    return `${t}=${
      r.status === 'rejected' ? truncErr((r as PromiseRejectedResult).reason) : 'ok'
    }`;
  }).join(' | ');
  throw new Error(`spawnFixRoaster: alle 3 Tiers failed (${reasons})`);
}

// --- Helpers ---------------------------------------------------------------

function truncErr(reason: unknown): string {
  const s = String(reason ?? '');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
