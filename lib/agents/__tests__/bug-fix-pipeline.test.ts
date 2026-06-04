/**
 * Tests fuer lib/agents/bug-fix-pipeline.ts (Sprint H+ · 2026-05-01).
 *
 * Run: `pnpm exec vitest run lib/agents/__tests__/bug-fix-pipeline.test.ts`
 *
 * Cases:
 *   1. Happy-Path: Detect→Analyze→Hypothesize→Plan→Critic-APPROVED→Fix→Verify→Audit
 *   2. Detect zu schwach -> Pipeline aborted, finalPhase='aborted'
 *   3. Critic BLOCKED erstmals, dann APPROVED -> replanCount=1, finalPhase='done'
 *   4. Critic permanent BLOCKED -> replanCount=maxReplan, finalPhase='aborted'
 *   5. defaultCriticHeuristic: scopeFiles>5 -> BLOCKED
 *   6. defaultCriticHeuristic: no-consensus + low conf -> BLOCKED
 *   7. defaultCriticHeuristic: weak plan -> WARN, nicht BLOCKED
 *   8. defaultCriticHeuristic: clean plan -> APPROVED
 *   9. Verify failed -> finalPhase='aborted', verifyResult.passed=false
 *  10. Audit-Failure macht NICHT die Pipeline failed (best-effort)
 *  11. onPhaseUpdate-Hook wird je Phase-Transition aufgerufen
 */

import { describe, it, expect } from 'vitest';

import {
  defaultCriticHeuristic,
  runBugFixPipeline,
  type CriticVerdict,
  type PipelineDeps,
  type RunBugFixPipelineInput,
  type SweepResult,
  type VerifyResult,
} from '../bug-fix-pipeline';
import type { FixPlan, Hypothesis } from '../bug-hypothesis';

function mkHyp(partial: Partial<Hypothesis>): Hypothesis {
  return {
    perspective: 'syntactic-perspective',
    summary: 'mock summary',
    files: [{ file: 'src/foo.ts' }],
    confidence: 0.7,
    raw: 'mock',
    ...partial,
  };
}

function mkPlan(partial: Partial<FixPlan>): FixPlan {
  return {
    winningHypothesis: mkHyp({}),
    rankedHypotheses: [{ hyp: mkHyp({}), score: 0.7 }],
    fixApproach: 'fix the null deref',
    scopeFiles: [{ file: 'src/foo.ts' }],
    planQuality: 'strong',
    ...partial,
  };
}

function bugInput(prompt: string, overrides: Partial<RunBugFixPipelineInput> = {}): RunBugFixPipelineInput {
  return {
    workspaceId: 'ws-1',
    workstreamId: 'WS-1',
    parentTicketId: 'TIK-1',
    workspacePath: '/tmp/mock',
    prompt,
    ...overrides,
  };
}

function approvedCritic(plan: FixPlan): CriticVerdict {
  return { verdict: 'APPROVED', findings: [], raw: `approved scope=${plan.scopeFiles.length}` };
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
    raw: 'mock-sweep · empty',
  };
}

function makeDeps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  let nowCounter = 1_000_000;
  return {
    readCodeContext: async () => 'mock-code-context',
    spawnHypothesis: async ({ perspective }) =>
      mkHyp({ perspective, summary: `mock ${perspective}` }),
    runCriticRoast: async ({ fixPlan }) => approvedCritic(fixPlan),
    runPatternSweep: async () => emptySweep(),
    applyFix: async () => ({ commitSha: 'abcdef0123', summary: 'fix applied' }),
    verifyFix: async () => passedVerify(),
    writeAudit: async () => undefined,
    now: () => nowCounter++,
    ...over,
  };
}

const HAPPY_BUG_PROMPT = `TypeError: Cannot read properties of undefined
    at AudioPlayer.start (audio-player.ts:42:18)
    at PlaybackQueue.advance (queue.ts:18:9)`;

describe('runBugFixPipeline', () => {
  it('happy path: detect -> ... -> done', async () => {
    const phaseSummaries: string[] = [];
    const deps = makeDeps({
      onPhaseUpdate: (rec) => {
        if (rec.status === 'done') phaseSummaries.push(rec.phase);
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    expect(result.replanCount).toBe(0);
    expect(result.fixPlan).toBeTruthy();
    expect(result.verifyResult?.passed).toBeTruthy();
    expect(phaseSummaries.includes('detect')).toBeTruthy();
    expect(phaseSummaries.includes('hypothesize')).toBeTruthy();
    expect(phaseSummaries.includes('plan')).toBeTruthy();
    expect(phaseSummaries.includes('critic')).toBeTruthy();
    expect(phaseSummaries.includes('sweep')).toBeTruthy();
    expect(phaseSummaries.includes('fix')).toBeTruthy();
    expect(phaseSummaries.includes('verify')).toBeTruthy();
    expect(phaseSummaries.includes('audit')).toBeTruthy();
    expect(result.sweepReplanCount).toBe(0);
  });

  it('detect insufficient -> aborted', async () => {
    const deps = makeDeps();
    const result = await runBugFixPipeline(deps, bugInput('hello, just chatting!'));
    expect(result.finalPhase).toBe('aborted');
    expect(result.indicators.confidence < 0.6).toBe(true);
    // Phase 1 sollte als 'skipped' geloggt sein, kein analyze/etc.
    expect(result.phases.length).toBe(1);
    expect(result.phases[0]!.phase).toBe('detect');
    expect(result.phases[0]!.status).toBe('skipped');
  });

  it('critic BLOCKED then APPROVED -> replanCount=1, done', async () => {
    let calls = 0;
    const deps = makeDeps({
      runCriticRoast: async ({ fixPlan }) => {
        calls++;
        if (calls === 1) {
          return {
            verdict: 'BLOCKED',
            findings: [{ severity: 'high', rule: 'test-block', text: 'first pass blocked' }],
            raw: 'blocked',
          };
        }
        return approvedCritic(fixPlan);
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    expect(result.replanCount).toBe(1);
    expect(calls).toBe(2);
  });

  it('critic permanently BLOCKED -> aborted at maxReplan', async () => {
    const deps = makeDeps({
      runCriticRoast: async () => ({
        verdict: 'BLOCKED',
        findings: [{ severity: 'high', rule: 'always-block', text: 'never approve' }],
        raw: 'blocked',
      }),
    });
    const result = await runBugFixPipeline(
      deps,
      bugInput(HAPPY_BUG_PROMPT, { maxReplanLoops: 2 }),
    );
    expect(result.finalPhase).toBe('aborted');
    expect(result.replanCount).toBe(3); // 0->1->2->3 (over limit)
    expect(result.criticVerdict?.verdict).toBe('BLOCKED');
  });

  it('verify fails -> aborted', async () => {
    const deps = makeDeps({
      verifyFix: async () => ({
        passed: false,
        steps: [
          { name: 'tsc', passed: true },
          { name: 'vitest', passed: false, output: '3 tests failed' },
        ],
      }),
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('aborted');
    expect(result.verifyResult?.passed).toBe(false);
  });

  it('audit-write failure does NOT fail the pipeline', async () => {
    const deps = makeDeps({
      writeAudit: async () => {
        throw new Error('db down');
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    // Pipeline pusht 'running' UND 'failed' für die Audit-Phase — wir suchen
    // den letzten Audit-Record (der finale Outcome).
    const auditRecords = result.phases.filter((p) => p.phase === 'audit');
    expect(auditRecords.length >= 1).toBeTruthy();
    const lastAudit = auditRecords[auditRecords.length - 1]!;
    expect(lastAudit.status).toBe('failed');
  });

  it('onPhaseUpdate hook fires for every phase transition', async () => {
    const updates: string[] = [];
    const deps = makeDeps({
      onPhaseUpdate: (rec) => {
        updates.push(`${rec.phase}:${rec.status}`);
      },
    });
    await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    // Sollte sowohl 'running' als auch 'done' enthalten für mehrere Phasen
    expect(updates.some((u) => u === 'analyze:running')).toBeTruthy();
    expect(updates.some((u) => u === 'analyze:done')).toBeTruthy();
    expect(updates.some((u) => u === 'sweep:running')).toBeTruthy();
    expect(updates.some((u) => u === 'sweep:done')).toBeTruthy();
    expect(updates.some((u) => u === 'fix:done')).toBeTruthy();
  });

  // ---------------- Phase 5.5 (Sweep) Tests · 2026-05-03 -------------------

  it('sweep phase runs after critic APPROVED and feeds applyFix', async () => {
    const sweepCalls: number[] = [];
    let appliedSweep: SweepResult | undefined;
    const sweep: SweepResult = {
      patternMatches: [
        {
          file: 'lib/foo/bar.ts',
          line: 42,
          snippet: 'thing.start()',
          similarity: 0.7,
          reason: 'same property access .start',
        },
      ],
      callers: [
        {
          file: 'lib/baz.ts',
          line: 11,
          callsite: "import { start } from './foo'",
          breakRisk: 'low',
        },
      ],
      affectedTests: ['lib/foo/__tests__/bar.test.ts'],
      suggestedNewTests: [
        { testName: 'bar pattern-regression', reason: 'unprotected access' },
      ],
      raw: 'sweep-run-1',
    };
    const deps = makeDeps({
      runPatternSweep: async () => {
        sweepCalls.push(Date.now());
        return sweep;
      },
      applyFix: async ({ sweepResult }) => {
        appliedSweep = sweepResult;
        return { commitSha: 'deadbeef', summary: 'fix applied' };
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    expect(sweepCalls.length).toBe(1);
    expect(appliedSweep).toEqual(sweep);
    // Sweep-Phase im Phase-Record vorhanden
    const sweepPhases = result.phases.filter((p) => p.phase === 'sweep');
    expect(sweepPhases.length >= 1).toBeTruthy();
    const sweepDone = sweepPhases.find((p) => p.status === 'done');
    expect(sweepDone).toBeTruthy();
    expect(sweepDone!.summary ?? '').toMatch(/1 andere Pattern-Matches/);
    expect(sweepDone!.summary ?? '').toMatch(/1 neue Tests/);
    expect(result.sweepResult).toEqual(sweep);
  });

  it('sweep with high-risk caller triggers re-plan once, then proceeds', async () => {
    let sweepCalls = 0;
    const dangerousSweep: SweepResult = {
      patternMatches: [],
      callers: [
        {
          file: 'app/api/critical/route.ts',
          line: 7,
          callsite: 'import { foo } from "../../lib/foo"',
          breakRisk: 'high',
        },
      ],
      affectedTests: [],
      suggestedNewTests: [],
      raw: 'high-risk',
    };
    const safeSweep: SweepResult = {
      patternMatches: [],
      callers: [
        {
          file: 'lib/other.ts',
          line: 9,
          callsite: 'foo()',
          breakRisk: 'low',
        },
      ],
      affectedTests: [],
      suggestedNewTests: [],
      raw: 'safe',
    };
    let critcCalls = 0;
    const deps = makeDeps({
      runCriticRoast: async ({ fixPlan }) => {
        critcCalls++;
        return approvedCritic(fixPlan);
      },
      runPatternSweep: async () => {
        sweepCalls++;
        return sweepCalls === 1 ? dangerousSweep : safeSweep;
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    expect(result.sweepReplanCount).toBe(1); // sweep re-plan happened once
    expect(sweepCalls).toBe(2); // sweep ran twice
    expect(critcCalls).toBe(2); // critic re-validated after sweep replan
    // Final fixPlan.scopeFiles enthält den Caller-File aus dem ersten Sweep
    expect(result.fixPlan?.scopeFiles.some((f) => f.file === 'app/api/critical/route.ts')).toBeTruthy();
    // sweep:failed-Record (re-plan) vorhanden + finaler sweep:done
    const sweepRecords = result.phases.filter((p) => p.phase === 'sweep');
    expect(sweepRecords.some((r) => r.status === 'failed')).toBeTruthy();
    expect(sweepRecords.some((r) => r.status === 'done')).toBeTruthy();
  });

  it('sweep high-risk persists past max-sweep-replan -> proceeds to fix anyway', async () => {
    // Sweep returnt IMMER high-risk. Wir erwarten, dass nach 1 Re-Plan die
    // Pipeline trotzdem zu Fix weitergeht (Sweep ist Warning, nicht Hard-Block).
    const dangerous: SweepResult = {
      patternMatches: [],
      callers: [
        { file: 'server/x.ts', line: 1, callsite: 'x()', breakRisk: 'high' },
      ],
      affectedTests: [],
      suggestedNewTests: [],
      raw: 'always-dangerous',
    };
    let sweepCalls = 0;
    const deps = makeDeps({
      runPatternSweep: async () => {
        sweepCalls++;
        return dangerous;
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    expect(result.sweepReplanCount).toBe(1);
    expect(sweepCalls).toBe(2); // one initial + one re-plan = 2 sweep runs
  });

  it('sweep failure does NOT abort pipeline (best-effort)', async () => {
    const deps = makeDeps({
      runPatternSweep: async () => {
        throw new Error('rg crashed');
      },
    });
    const result = await runBugFixPipeline(deps, bugInput(HAPPY_BUG_PROMPT));
    expect(result.finalPhase).toBe('done');
    expect(result.sweepResult).toBe(undefined);
    const sweepFailed = result.phases.find(
      (p) => p.phase === 'sweep' && p.status === 'failed',
    );
    expect(sweepFailed).toBeTruthy();
  });
});

describe('defaultCriticHeuristic', () => {
  it('scope > 5 files -> BLOCKED', () => {
    const plan = mkPlan({
      scopeFiles: [
        { file: 'a.ts' },
        { file: 'b.ts' },
        { file: 'c.ts' },
        { file: 'd.ts' },
        { file: 'e.ts' },
        { file: 'f.ts' },
      ],
    });
    const v = defaultCriticHeuristic(plan);
    expect(v.verdict).toBe('BLOCKED');
    expect(v.findings.some((f) => f.rule === 'scope-too-large')).toBeTruthy();
  });

  it('no-consensus + low confidence -> BLOCKED', () => {
    const plan = mkPlan({
      planQuality: 'no-consensus',
      winningHypothesis: mkHyp({ confidence: 0.2 }),
    });
    const v = defaultCriticHeuristic(plan);
    expect(v.verdict).toBe('BLOCKED');
    expect(v.findings.some((f) => f.rule === 'no-consensus-low-confidence')).toBeTruthy();
  });

  it('weak plan -> WARN, not BLOCKED', () => {
    const plan = mkPlan({ planQuality: 'weak' });
    const v = defaultCriticHeuristic(plan);
    expect(v.verdict).toBe('WARN');
  });

  it('clean plan -> APPROVED', () => {
    const plan = mkPlan({});
    const v = defaultCriticHeuristic(plan);
    expect(v.verdict).toBe('APPROVED');
    expect(v.findings.length).toBe(0);
  });

  it('empty winning summary -> BLOCKED', () => {
    const plan = mkPlan({ winningHypothesis: mkHyp({ summary: '' }) });
    const v = defaultCriticHeuristic(plan);
    expect(v.verdict).toBe('BLOCKED');
    expect(v.findings.some((f) => f.rule === 'empty-summary')).toBeTruthy();
  });
});
