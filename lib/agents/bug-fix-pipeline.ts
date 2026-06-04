/**
 * lib/agents/bug-fix-pipeline.ts
 * ------------------------------
 * Sprint H+ · 2026-05-01 — Bug-fix pipeline with 8 phases + pre-implementation critic.
 *
 * User complaint 2026-05-01 (verbatim):
 *   „bug fixes bisher ultra schlecht gelöst, also qualität hat ultra gelitten.
 *    scheinbar keine automatische planung für code analyse und ernsthafte
 *    überlegung wo errors sein könnten"
 *
 * 8 phases:
 *   1. Detect       — bug pattern detection (lib/agents/bug-detector)
 *   2. Analyze      — code read around the bug (reproducible?)
 *   3. Hypothesize  — 3 independent root-cause hypotheses via 3-tier sub-spawn
 *   4. Plan         — synthesis: which hypothesis, which fix approach
 *   5. Critic       — before fix: pre-implementation critic roast (BLOCKED → re-plan)
 *   6. Fix          — implementation
 *   7. Verify       — tests + tsc + manual smoke
 *   8. Reasoning-Audit — trail in the reasoning_audit table
 *
 * This file is the orchestrating pure-logic layer. The caller injects:
 *   - spawnHypothesis()  -> wraps spawnInTmux + parseDiagnosis
 *   - readCodeContext()  -> wraps fs reads
 *   - runCriticRoast()   -> wraps spawnInTmux with a critic prompt
 *   - applyFix()         -> wraps existing bug-swarm fix phase
 *   - verifyFix()        -> wraps tsc + tests
 *   - writeAudit()       -> wraps reasoning.writeReasoningAudit
 *
 * This makes the whole pipeline testable without LLM/filesystem.
 */

import {
  detectBugIndicators,
  shouldRunPipeline,
  type BugIndicators,
} from './bug-detector';
import {
  spawnHypothesesParallel,
  synthesizeFixPlan,
  type FixPlan,
  type Hypothesis,
  type HypothesisSpawnFn,
} from './bug-hypothesis';
import {
  spawnPlanRoaster,
  spawnCriticSwarm,
  spawnFixRoaster,
  type PlanSpawnFn,
  type CriticSpawnFn,
  type FixSpawnFn,
  type CriticSwarmVerdict,
  type FixRoasterOutput,
} from './bug-fix-roasters';
import type { SweepResult } from './pattern-sweep';

export type { SweepResult } from './pattern-sweep';

export type Phase =
  | 'detect'
  | 'analyze'
  | 'hypothesize'
  | 'plan'
  | 'critic'
  | 'sweep'
  | 'fix'
  | 'verify'
  | 'audit'
  | 'done'
  | 'aborted';

export type PhaseStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface PhaseRecord {
  phase: Phase;
  status: PhaseStatus;
  startedAt: number;
  finishedAt?: number;
  /** 1-line summary for the UI. */
  summary?: string;
  /** Detail payload per phase (hypotheses, critic findings, test output, etc.). */
  detail?: unknown;
  /** Error message when status='failed'. */
  error?: string;
}

export interface CriticVerdict {
  verdict: 'APPROVED' | 'BLOCKED' | 'WARN';
  /** Findings that must be fixed before implementation. */
  findings: ReadonlyArray<{
    severity: 'high' | 'medium' | 'low';
    rule: string;
    text: string;
  }>;
  /** Raw critic output for audit. */
  raw: string;
}

export interface VerifyResult {
  /** Did tsc/tests/build pass cleanly? */
  passed: boolean;
  /** Which steps ran (tsc, vitest, build, smoke). */
  steps: ReadonlyArray<{ name: string; passed: boolean; output?: string }>;
}

export interface PipelineDeps {
  /** Phase 2: load code context (default: read 50 lines around fileHints). */
  readCodeContext: (
    workspacePath: string,
    fileHints: ReadonlyArray<{ file: string; line?: number }>,
  ) => Promise<string>;

  /** Phase 3: 3 hypothesis spawns in parallel. */
  spawnHypothesis: HypothesisSpawnFn;

  /**
   * Phase 4 (Plan) — 3-tier roaster (Wave 2 · 2026-05-03).
   * Optional: if not set, the pipeline code falls back to solo
   * `synthesizeFixPlan(hypotheses)` (backwards compat for tests
   * and callers that only want a single-tier plan).
   */
  spawnPlan?: PlanSpawnFn;

  /**
   * Phase 5 (Critic) — 3-tier devil's-advocate swarm (Wave 2 · 2026-05-03).
   * If set: replaces `runCriticRoast` as the critic path. The re-plan loop
   * is reduced to max 1 cycle.
   */
  spawnCritic?: CriticSpawnFn;

  /**
   * Phase 6 (Fix) — Opus primary + Sonnet/Haiku as backup (Wave 2).
   * If set: replaces `applyFix`. Backwards-compat otherwise.
   */
  spawnFix?: FixSpawnFn;

  /** Phase 5: pre-implementation critic (solo fallback when `spawnCritic` is missing). */
  runCriticRoast: (input: {
    fixPlan: FixPlan;
    bugDescription: string;
    workspacePath: string;
  }) => Promise<CriticVerdict>;

  /**
   * Phase 5.5: pattern sweep + caller graph (Sprint H+ · 2026-05-03).
   * Runs AFTER an approved critic. Finds other spots where
   * the same bug pattern might lurk + analyzes caller side effects.
   */
  runPatternSweep: (input: {
    fixPlan: FixPlan;
    bugIndicators: BugIndicators;
    workspacePath: string;
    workstreamId: string;
  }) => Promise<SweepResult>;

  /**
   * Phase 6: apply the fix — delegates to the existing bug-swarm fix logic.
   * `sweepResult` (phase 5.5) is passed through so the fix spawn
   * can co-fix pattern matches in the same commit.
   */
  applyFix: (input: {
    fixPlan: FixPlan;
    sweepResult?: SweepResult;
    bugDescription: string;
    workspacePath: string;
    workstreamId: string;
  }) => Promise<{ commitSha?: string; summary: string }>;

  /** Phase 7: verify — tsc + tests + build if applicable. */
  verifyFix: (input: {
    workspacePath: string;
    scopeFiles: ReadonlyArray<{ file: string; line?: number }>;
  }) => Promise<VerifyResult>;

  /** Phase 8: reasoning-audit trail. */
  writeAudit: (input: {
    workspaceId: string;
    workstreamId: string;
    parentTicketId: string;
    phase: Phase;
    role: string;
    summary: string;
    detail?: unknown;
  }) => Promise<void>;

  /** Optional: hook for UI updates (phase-stepper live sync). */
  onPhaseUpdate?: (record: PhaseRecord) => void;

  /** Optional: now-provider for deterministic tests. */
  now?: () => number;
}

export interface RunBugFixPipelineInput {
  workspaceId: string;
  workstreamId: string;
  parentTicketId: string;
  workspacePath: string;
  prompt: string;
  /** Override the detection result (for callers that already did detection). */
  preDetectedIndicators?: BugIndicators;
  /** Max re-plan loops on critic BLOCKED (default 3). */
  maxReplanLoops?: number;
  /** Min-confidence override for detection. */
  minConfidence?: number;
}

export interface RunBugFixPipelineResult {
  /** Final phase: 'done' when everything went through, 'aborted' when the pipeline stops early. */
  finalPhase: Phase;
  /** All phase records in order. */
  phases: ReadonlyArray<PhaseRecord>;
  /** Detected bug indicators (phase 1). */
  indicators: BugIndicators;
  /** Plan (phase 4) — can be undefined if the pipeline aborted early. */
  fixPlan?: FixPlan;
  /** Critic verdict — last iteration. */
  criticVerdict?: CriticVerdict;
  /** Wave 2 (2026-05-03): if swarm mode is active, the tier verdicts here. */
  criticSwarm?: CriticSwarmVerdict;
  /** Sweep result (phase 5.5). */
  sweepResult?: SweepResult;
  /** Verify result (phase 7). */
  verifyResult?: VerifyResult;
  /** How often a re-plan happened due to critic BLOCKED. */
  replanCount: number;
  /** How often a re-plan happened due to sweep high breakRisk. Max 1. */
  sweepReplanCount: number;
}

const DEFAULT_NOW = () => Date.now();

/**
 * Main orchestrator. Calls the phases serially, fires the
 * `onPhaseUpdate` hook after every phase update.
 *
 * Abort conditions (pipeline aborted):
 *   - Phase 1 detectBugIndicators -> insufficient confidence
 *   - Phase 5 critic BLOCKED after maxReplanLoops attempts
 *   - Phase 7 verify failed
 *   - every phase throw is logged as 'failed' + the pipeline aborted
 */
export async function runBugFixPipeline(
  deps: PipelineDeps,
  input: RunBugFixPipelineInput,
): Promise<RunBugFixPipelineResult> {
  const now = deps.now ?? DEFAULT_NOW;
  const phases: PhaseRecord[] = [];
  const log = (rec: PhaseRecord) => {
    phases.push(rec);
    deps.onPhaseUpdate?.(rec);
  };

  // ---- Phase 1: Detect ----
  const detectStart = now();
  const indicators =
    input.preDetectedIndicators ?? detectBugIndicators(input.prompt);
  if (!shouldRunPipeline(indicators, { minConfidence: input.minConfidence })) {
    log({
      phase: 'detect',
      status: 'skipped',
      startedAt: detectStart,
      finishedAt: now(),
      summary: `confidence=${indicators.confidence} < threshold — pipeline not started`,
      detail: indicators,
    });
    return {
      finalPhase: 'aborted',
      phases,
      indicators,
      replanCount: 0,
      sweepReplanCount: 0,
    };
  }
  log({
    phase: 'detect',
    status: 'done',
    startedAt: detectStart,
    finishedAt: now(),
    summary: `${indicators.category} (confidence ${indicators.confidence})`,
    detail: indicators,
  });

  // ---- Phase 2: Analyze (load code context) ----
  const analyzeStart = now();
  log({
    phase: 'analyze',
    status: 'running',
    startedAt: analyzeStart,
    summary: `Lade Kontext für ${indicators.fileHints.length} File-Hints`,
  });
  let codeContext = '';
  try {
    codeContext = await deps.readCodeContext(input.workspacePath, indicators.fileHints);
    log({
      phase: 'analyze',
      status: 'done',
      startedAt: analyzeStart,
      finishedAt: now(),
      summary: `Kontext geladen (${codeContext.length} chars)`,
    });
  } catch (err) {
    log({
      phase: 'analyze',
      status: 'failed',
      startedAt: analyzeStart,
      finishedAt: now(),
      error: errMsg(err),
    });
    return abortResult(phases, indicators);
  }

  // ---- Phase 3: Hypothesize (3 parallel Spawns) ----
  const hypoStart = now();
  log({
    phase: 'hypothesize',
    status: 'running',
    startedAt: hypoStart,
    summary: '3 Perspektiven parallel: syntactic/semantic/environmental',
  });
  let hypotheses: Hypothesis[];
  try {
    hypotheses = await spawnHypothesesParallel(deps.spawnHypothesis, {
      bugDescription: input.prompt,
      codeContext,
      workspacePath: input.workspacePath,
      workstreamId: input.workstreamId,
    });
  } catch (err) {
    log({
      phase: 'hypothesize',
      status: 'failed',
      startedAt: hypoStart,
      finishedAt: now(),
      error: errMsg(err),
    });
    return abortResult(phases, indicators);
  }
  log({
    phase: 'hypothesize',
    status: 'done',
    startedAt: hypoStart,
    finishedAt: now(),
    summary: `${hypotheses.length} Hypothesen gesammelt`,
    detail: hypotheses,
  });

  // ---- Phase 4: Plan ----
  // Wave 2 (2026-05-03): 3-tier roaster if `deps.spawnPlan` is set,
  // otherwise solo `synthesizeFixPlan` (backwards compat).
  const planStart = now();
  const planMode = deps.spawnPlan ? 'roaster' : 'solo';
  log({
    phase: 'plan',
    status: 'running',
    startedAt: planStart,
    summary: planMode === 'roaster'
      ? '3× Opus-Roaster (parallel)' // Opus-only (owner directive) — all slots Opus 4.8
      : 'Solo synthesizeFixPlan',
  });
  let fixPlan: FixPlan;
  try {
    if (deps.spawnPlan) {
      fixPlan = await spawnPlanRoaster({
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        hypotheses,
        spawn: deps.spawnPlan,
      });
    } else {
      fixPlan = synthesizeFixPlan(hypotheses);
    }
  } catch (err) {
    log({
      phase: 'plan',
      status: 'failed',
      startedAt: planStart,
      finishedAt: now(),
      error: errMsg(err),
    });
    return abortResult(phases, indicators);
  }
  log({
    phase: 'plan',
    status: 'done',
    startedAt: planStart,
    finishedAt: now(),
    summary: `${fixPlan.planQuality} consensus, winning=${fixPlan.winningHypothesis.perspective} [${planMode}]`,
    detail: fixPlan,
  });

  // ---- Phase 5: Critic (pre-implementation) + Phase 5.5 sweep — re-plan loop ----
  // Wave 2 (2026-05-03): with `spawnCritic` (swarm mode) we reduce
  // the re-plan loop to max 1 cycle. Otherwise it stays at the limit set
  // by the caller (default 3, backwards compat).
  const criticMode: 'swarm' | 'solo' = deps.spawnCritic ? 'swarm' : 'solo';
  const maxReplan =
    input.maxReplanLoops !== undefined
      ? input.maxReplanLoops
      : criticMode === 'swarm'
      ? 1
      : 3;
  const MAX_SWEEP_REPLAN = 1;
  let criticVerdict: CriticVerdict | undefined;
  let criticSwarm: CriticSwarmVerdict | undefined;
  let sweepResult: SweepResult | undefined;
  let replanCount = 0;
  let sweepReplanCount = 0;

  // Outer loop: critic + sweep can both trigger a re-plan.
  // We only leave it once the critic is non-BLOCKED AND the sweep is non-high-risk.
  outer: while (true) {
    // -- Phase 5: Critic --
    const criticStart = now();
    log({
      phase: 'critic',
      status: 'running',
      startedAt: criticStart,
      summary:
        replanCount === 0
          ? criticMode === 'swarm'
            ? '3-Tier-Critic-Swarm (Devil\'s-Advocate)'
            : 'Pre-Implementation-Critic'
          : `Re-Plan-Loop ${replanCount}/${maxReplan} [${criticMode}]`,
    });
    try {
      if (deps.spawnCritic) {
        criticSwarm = await spawnCriticSwarm({
          workspaceId: input.workspaceId,
          workstreamId: input.workstreamId,
          fixPlan,
          spawn: deps.spawnCritic,
        });
        // Map the swarm verdict to a classic CriticVerdict for UI/audit compat.
        criticVerdict = swarmToCriticVerdict(criticSwarm);
      } else {
        criticVerdict = await deps.runCriticRoast({
          fixPlan,
          bugDescription: input.prompt,
          workspacePath: input.workspacePath,
        });
      }
    } catch (err) {
      log({
        phase: 'critic',
        status: 'failed',
        startedAt: criticStart,
        finishedAt: now(),
        error: errMsg(err),
      });
      return abortResult(phases, indicators, fixPlan);
    }
    log({
      phase: 'critic',
      status: 'done',
      startedAt: criticStart,
      finishedAt: now(),
      summary:
        criticMode === 'swarm' && criticSwarm
          ? criticSwarm.summary
          : `${criticVerdict.verdict} (${criticVerdict.findings.length} findings)`,
      detail: { verdict: criticVerdict, swarm: criticSwarm ?? undefined },
    });

    if (criticVerdict.verdict === 'BLOCKED') {
      replanCount++;
      if (replanCount > maxReplan) {
        // Re-plan loop exhausted -> pipeline aborted
        log({
          phase: 'aborted',
          status: 'failed',
          startedAt: now(),
          finishedAt: now(),
          summary: `Critic BLOCKED nach ${maxReplan} Re-Plan-Loops`,
        });
        return {
          finalPhase: 'aborted',
          phases,
          indicators,
          fixPlan,
          criticVerdict,
          criticSwarm,
          sweepResult,
          replanCount,
          sweepReplanCount,
        };
      }
      const filtered = hypotheses.filter((h) => h.confidence >= 0.2);
      if (filtered.length === 0) {
        return {
          finalPhase: 'aborted',
          phases,
          indicators,
          fixPlan,
          criticVerdict,
          criticSwarm,
          sweepResult,
          replanCount,
          sweepReplanCount,
        };
      }
      hypotheses = filtered;
      // Wave 2: re-plan also in swarm mode via roaster, otherwise solo.
      if (deps.spawnPlan) {
        try {
          fixPlan = await spawnPlanRoaster({
            workspaceId: input.workspaceId,
            workstreamId: input.workstreamId,
            hypotheses,
            spawn: deps.spawnPlan,
          });
        } catch {
          // Fallback on roaster crash → solo.
          fixPlan = synthesizeFixPlan(hypotheses);
        }
      } else {
        fixPlan = synthesizeFixPlan(hypotheses);
      }
      continue outer; // → critic again + sweep if applicable
    }

    // -- Phase 5.5: Pattern-Sweep + Caller-Graph --
    const sweepStart = now();
    log({
      phase: 'sweep',
      status: 'running',
      startedAt: sweepStart,
      summary: 'Pattern-Sweep + Caller-Graph',
    });
    try {
      sweepResult = await deps.runPatternSweep({
        fixPlan,
        bugIndicators: indicators,
        workspacePath: input.workspacePath,
        workstreamId: input.workstreamId,
      });
    } catch (err) {
      // A sweep failure is NOT a pipeline abort — we log it as 'failed'
      // and continue to fix without a sweepResult. A sweep failure should
      // not block the bug fix — that would be a regression.
      log({
        phase: 'sweep',
        status: 'failed',
        startedAt: sweepStart,
        finishedAt: now(),
        error: errMsg(err),
      });
      sweepResult = undefined;
      break outer;
    }

    const highRiskCallers = sweepResult.callers.filter((c) => c.breakRisk === 'high');
    const sweepSummary =
      `${sweepResult.patternMatches.length} andere Pattern-Matches · ` +
      `${sweepResult.callers.length} Caller (${highRiskCallers.length} high-risk) · ` +
      `${sweepResult.suggestedNewTests.length} neue Tests vorgeschlagen`;

    if (highRiskCallers.length > 0 && sweepReplanCount < MAX_SWEEP_REPLAN) {
      // Trigger a re-plan: caller info flows into the plan via fixApproach
      // — the hypotheses stay, the plan is re-synthesized.
      log({
        phase: 'sweep',
        status: 'failed',
        startedAt: sweepStart,
        finishedAt: now(),
        summary: `${sweepSummary} → Re-Plan (Caller-Risk)`,
        detail: sweepResult,
      });
      sweepReplanCount++;

      // Re-plan: incorporate sweep findings as additional scope in fixPlan.
      // We extend scopeFiles with the caller files so critic + fix
      // take them into account.
      const callerFiles = highRiskCallers.map((c) => ({ file: c.file, line: c.line }));
      const mergedScope = mergeScope(fixPlan.scopeFiles, callerFiles);
      fixPlan = {
        ...fixPlan,
        scopeFiles: mergedScope,
        fixApproach:
          fixPlan.fixApproach +
          ` [SWEEP-REPLAN: ${highRiskCallers.length} high-risk caller(s) — bitte Backwards-Compat sicherstellen]`,
      };
      continue outer; // → critic + sweep again
    }

    // Sweep without high-risk → done
    log({
      phase: 'sweep',
      status: 'done',
      startedAt: sweepStart,
      finishedAt: now(),
      summary: sweepSummary,
      detail: sweepResult,
    });
    break outer;
  }

  // ---- Phase 6: Fix ----
  // Wave 2 (2026-05-03): roaster mode (Opus primary + Sonnet/Haiku backup)
  // if `deps.spawnFix` is set — otherwise solo `applyFix`.
  const fixStart = now();
  const fixMode: 'roaster' | 'solo' = deps.spawnFix ? 'roaster' : 'solo';
  log({
    phase: 'fix',
    status: 'running',
    startedAt: fixStart,
    summary: fixMode === 'roaster' ? 'Fix-Roaster (3× Opus, erster Erfolg gewinnt)' : 'Solo applyFix', // Opus-only (owner directive)
  });
  let fixOut: { commitSha?: string; summary: string };
  let fixRoasterDetail: FixRoasterOutput | undefined;
  try {
    if (deps.spawnFix) {
      fixRoasterDetail = await spawnFixRoaster({
        workspaceId: input.workspaceId,
        workstreamId: input.workstreamId,
        workspacePath: input.workspacePath,
        bugDescription: input.prompt,
        fixPlan,
        spawn: deps.spawnFix,
      });
      fixOut = {
        commitSha: fixRoasterDetail.commitSha,
        summary: fixRoasterDetail.summary,
      };
    } else {
      fixOut = await deps.applyFix({
        fixPlan,
        sweepResult,
        bugDescription: input.prompt,
        workspacePath: input.workspacePath,
        workstreamId: input.workstreamId,
      });
    }
  } catch (err) {
    log({
      phase: 'fix',
      status: 'failed',
      startedAt: fixStart,
      finishedAt: now(),
      error: errMsg(err),
    });
    return abortResult(phases, indicators, fixPlan, criticVerdict, sweepResult);
  }
  log({
    phase: 'fix',
    status: 'done',
    startedAt: fixStart,
    finishedAt: now(),
    summary: fixOut.commitSha
      ? `committed ${fixOut.commitSha.slice(0, 8)}${fixRoasterDetail?.fallback ? ` [fallback=${fixRoasterDetail.tier}]` : fixRoasterDetail ? ` [${fixRoasterDetail.tier}]` : ''}`
      : fixOut.summary,
    detail: fixRoasterDetail ?? fixOut,
  });

  // ---- Phase 7: Verify ----
  const verifyStart = now();
  log({ phase: 'verify', status: 'running', startedAt: verifyStart });
  let verifyResult: VerifyResult;
  try {
    verifyResult = await deps.verifyFix({
      workspacePath: input.workspacePath,
      scopeFiles: fixPlan.scopeFiles,
    });
  } catch (err) {
    log({
      phase: 'verify',
      status: 'failed',
      startedAt: verifyStart,
      finishedAt: now(),
      error: errMsg(err),
    });
    return abortResult(phases, indicators, fixPlan, criticVerdict, sweepResult);
  }
  log({
    phase: 'verify',
    status: verifyResult.passed ? 'done' : 'failed',
    startedAt: verifyStart,
    finishedAt: now(),
    summary: `${verifyResult.steps.filter((s) => s.passed).length}/${verifyResult.steps.length} steps passed`,
    detail: verifyResult,
  });
  if (!verifyResult.passed) {
    return {
      finalPhase: 'aborted',
      phases,
      indicators,
      fixPlan,
      criticVerdict,
      criticSwarm,
      sweepResult,
      verifyResult,
      replanCount,
      sweepReplanCount,
    };
  }

  // ---- Phase 8: Reasoning audit ----
  const auditStart = now();
  log({ phase: 'audit', status: 'running', startedAt: auditStart });
  try {
    await deps.writeAudit({
      workspaceId: input.workspaceId,
      workstreamId: input.workstreamId,
      parentTicketId: input.parentTicketId,
      phase: 'audit',
      role: 'bug-fix-pipeline',
      summary: `Pipeline durch — ${fixPlan.winningHypothesis.perspective}, ${replanCount} re-plans, ${sweepReplanCount} sweep-re-plans`,
      detail: {
        indicators,
        fixPlan,
        criticVerdict,
        sweepResult,
        verifyResult,
        replanCount,
        sweepReplanCount,
      },
    });
    log({
      phase: 'audit',
      status: 'done',
      startedAt: auditStart,
      finishedAt: now(),
      summary: 'Audit-Trail persistiert',
    });
  } catch (err) {
    // An audit failure does NOT fail the whole pipeline — we log it
    // and still return 'done'.
    log({
      phase: 'audit',
      status: 'failed',
      startedAt: auditStart,
      finishedAt: now(),
      error: errMsg(err),
    });
  }

  return {
    finalPhase: 'done',
    phases,
    indicators,
    fixPlan,
    criticVerdict,
    criticSwarm,
    sweepResult,
    verifyResult,
    replanCount,
    sweepReplanCount,
  };
}

// --- Default critic heuristic (caller can override) --------------------------

/**
 * Heuristic quality gates for the pre-implementation critic.
 * If the caller does not want an LLM critic spawn (e.g. test/dry-run),
 * this function can be used directly.
 *
 * BLOCKED conditions:
 *   - planQuality === 'no-consensus' AND winningHypothesis.confidence < 0.4
 *   - scopeFiles.length > 5  (too much scope for a single bug fix)
 *   - winningHypothesis.summary empty
 *
 * WARN conditions:
 *   - planQuality === 'weak'
 *   - scopeFiles.length === 0
 */
export function defaultCriticHeuristic(plan: FixPlan): CriticVerdict {
  const findings: Array<{ severity: 'high' | 'medium' | 'low'; rule: string; text: string }> = [];

  if (plan.planQuality === 'no-consensus' && plan.winningHypothesis.confidence < 0.4) {
    findings.push({
      severity: 'high',
      rule: 'no-consensus-low-confidence',
      text: 'Keine 2 Hypothesen einigen sich auf eine Datei — und die führende Hypothese hat <0.4 Confidence. Pipeline blockiert.',
    });
  }
  if (plan.scopeFiles.length > 5) {
    findings.push({
      severity: 'high',
      rule: 'scope-too-large',
      text: `Fix-Scope umfasst ${plan.scopeFiles.length} Dateien — Bug-Fix sollte fokussiert sein. Zerlege in mehrere Tickets.`,
    });
  }
  if (!plan.winningHypothesis.summary || plan.winningHypothesis.summary.trim().length < 5) {
    findings.push({
      severity: 'high',
      rule: 'empty-summary',
      text: 'Winning-Hypothese hat keine sinnvolle Summary.',
    });
  }
  if (plan.planQuality === 'weak') {
    findings.push({
      severity: 'medium',
      rule: 'weak-plan',
      text: 'Alle Hypothesen haben Confidence <0.3 — Plan ist Best-Guess.',
    });
  }
  if (plan.scopeFiles.length === 0) {
    findings.push({
      severity: 'medium',
      rule: 'empty-scope',
      text: 'Keine Scope-Files — Fix-Spawn wird raten müssen welche Files zu touchen.',
    });
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasMed = findings.some((f) => f.severity === 'medium');
  const verdict: 'APPROVED' | 'BLOCKED' | 'WARN' = hasHigh
    ? 'BLOCKED'
    : hasMed
    ? 'WARN'
    : 'APPROVED';

  return {
    verdict,
    findings,
    raw: `defaultCriticHeuristic: verdict=${verdict}, ${findings.length} findings`,
  };
}

// --- Helpers -----------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function abortResult(
  phases: PhaseRecord[],
  indicators: BugIndicators,
  fixPlan?: FixPlan,
  criticVerdict?: CriticVerdict,
  sweepResult?: SweepResult,
): RunBugFixPipelineResult {
  return {
    finalPhase: 'aborted',
    phases,
    indicators,
    fixPlan,
    criticVerdict,
    sweepResult,
    replanCount: 0,
    sweepReplanCount: 0,
  };
}

/**
 * Wave 2 (2026-05-03): map CriticSwarmVerdict → classic CriticVerdict.
 *
 * So the pipeline loop (which checks `criticVerdict.verdict ===
 * 'BLOCKED'`) and the audit path still run against the existing CriticVerdict
 * shape — only the source is now the 3-tier swarm aggregate.
 *
 * Mapping:
 *   - swarm.allow=true  → verdict='APPROVED'
 *   - swarm.allow=false → verdict='BLOCKED' with findings per BLOCKED tier
 */
function swarmToCriticVerdict(swarm: CriticSwarmVerdict): CriticVerdict {
  const findings = swarm.tiers
    .filter((t) => t.verdict === 'BLOCKED')
    .map((t) => ({
      severity: 'high' as const,
      rule: `critic-tier-blocked-${t.tier}`,
      text: `${t.tier}: ${t.reason}`,
    }));
  const verdict: CriticVerdict['verdict'] = swarm.allow ? 'APPROVED' : 'BLOCKED';
  return {
    verdict,
    findings,
    raw: swarm.summary,
  };
}

/** Scope merge: existing scope plus new files, dedupe by file. */
function mergeScope(
  existing: ReadonlyArray<{ file: string; line?: number }>,
  add: ReadonlyArray<{ file: string; line?: number }>,
): ReadonlyArray<{ file: string; line?: number }> {
  const out = new Map<string, { file: string; line?: number }>();
  for (const f of existing) out.set(f.file, f);
  for (const f of add) if (!out.has(f.file)) out.set(f.file, f);
  return Array.from(out.values());
}
