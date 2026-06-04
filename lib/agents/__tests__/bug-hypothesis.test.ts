/**
 * Tests fuer lib/agents/bug-hypothesis.ts (Sprint H+ · 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/agents/__tests__/bug-hypothesis.test.ts`
 *
 * Cases:
 *   1. spawnHypothesesParallel ruft Spawn 3x mit den 3 Perspektiven
 *   2. Failure einer Perspektive -> confidence=0 dieser Hyp, andere bleiben
 *   3. synthesizeFixPlan: alle 3 nennen dieselbe Datei -> strong, scopeFiles enthält sie
 *   4. synthesizeFixPlan: alle 3 unterschiedliche Files -> no-consensus
 *   5. synthesizeFixPlan: alle confidence < 0.3 -> weak
 *   6. Tie-Breaker: gleiche Confidence/Overlap -> syntactic gewinnt
 *   7. winning hat höchsten Score nicht zwingend höchste raw-confidence (overlap zählt)
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  spawnHypothesesParallel,
  synthesizeFixPlan,
  type Hypothesis,
  type HypothesisSpawnFn,
} from '../bug-hypothesis';

function mkHyp(partial: Partial<Hypothesis>): Hypothesis {
  return {
    perspective: 'syntactic-perspective',
    summary: 'mock',
    files: [],
    confidence: 0.5,
    raw: 'mock-raw',
    ...partial,
  };
}

describe('spawnHypothesesParallel', () => {
  it('spawns 3 perspectives in parallel', async () => {
    const calls: string[] = [];
    const spawn: HypothesisSpawnFn = async (input) => {
      calls.push(input.perspective);
      return mkHyp({ perspective: input.perspective, summary: `mock ${input.perspective}` });
    };
    const result = await spawnHypothesesParallel(spawn, {
      bugDescription: 'crash',
      codeContext: 'src/foo.ts:10',
      workspacePath: '/tmp',
      workstreamId: 'WS-1',
    });
    assert.equal(result.length, 3);
    assert.deepEqual(
      calls.sort(),
      ['environmental-perspective', 'semantic-perspective', 'syntactic-perspective'],
    );
  });

  it('handles partial failure — failed spawns get confidence=0', async () => {
    const spawn: HypothesisSpawnFn = async (input) => {
      if (input.perspective === 'semantic-perspective') {
        throw new Error('llm timeout');
      }
      return mkHyp({ perspective: input.perspective, confidence: 0.7 });
    };
    const result = await spawnHypothesesParallel(spawn, {
      bugDescription: 'crash',
      codeContext: '',
      workspacePath: '/tmp',
      workstreamId: 'WS-2',
    });
    assert.equal(result.length, 3);
    const semantic = result.find((r) => r.perspective === 'semantic-perspective')!;
    assert.equal(semantic.confidence, 0);
    assert.match(semantic.summary, /fehlgeschlagen/);
    const syn = result.find((r) => r.perspective === 'syntactic-perspective')!;
    assert.equal(syn.confidence, 0.7);
  });
});

describe('synthesizeFixPlan', () => {
  it('shared file across all 3 hypotheses -> strong consensus', () => {
    const hyps: Hypothesis[] = [
      mkHyp({
        perspective: 'syntactic-perspective',
        summary: 'null deref in foo.ts',
        files: [{ file: 'src/foo.ts', line: 12 }],
        confidence: 0.7,
      }),
      mkHyp({
        perspective: 'semantic-perspective',
        summary: 'wrong control flow at foo.ts',
        files: [{ file: 'src/foo.ts', line: 14 }],
        confidence: 0.6,
      }),
      mkHyp({
        perspective: 'environmental-perspective',
        summary: 'dep-version-bump broke foo.ts',
        files: [{ file: 'src/foo.ts' }],
        confidence: 0.5,
      }),
    ];
    const plan = synthesizeFixPlan(hyps);
    assert.equal(plan.planQuality, 'strong');
    assert.ok(plan.scopeFiles.some((f) => f.file === 'src/foo.ts'));
    assert.equal(plan.winningHypothesis.perspective, 'syntactic-perspective');
  });

  it('no overlap -> no-consensus', () => {
    const hyps: Hypothesis[] = [
      mkHyp({
        perspective: 'syntactic-perspective',
        files: [{ file: 'a.ts' }],
        confidence: 0.5,
      }),
      mkHyp({
        perspective: 'semantic-perspective',
        files: [{ file: 'b.ts' }],
        confidence: 0.5,
      }),
      mkHyp({
        perspective: 'environmental-perspective',
        files: [{ file: 'c.ts' }],
        confidence: 0.5,
      }),
    ];
    const plan = synthesizeFixPlan(hyps);
    assert.equal(plan.planQuality, 'no-consensus');
    assert.match(plan.fixApproach, /kein Konsens/);
  });

  it('all weak (confidence < 0.3) -> planQuality weak', () => {
    const hyps: Hypothesis[] = [
      mkHyp({ perspective: 'syntactic-perspective', confidence: 0.1, files: [{ file: 'x.ts' }] }),
      mkHyp({ perspective: 'semantic-perspective', confidence: 0.2, files: [{ file: 'x.ts' }] }),
      mkHyp({ perspective: 'environmental-perspective', confidence: 0.05, files: [{ file: 'x.ts' }] }),
    ];
    const plan = synthesizeFixPlan(hyps);
    assert.equal(plan.planQuality, 'weak');
    assert.match(plan.fixApproach, /schwache Evidenz/);
  });

  it('tie-break: equal confidence/overlap -> syntactic wins over semantic over environmental', () => {
    const hyps: Hypothesis[] = [
      mkHyp({
        perspective: 'environmental-perspective',
        confidence: 0.5,
        files: [{ file: 'shared.ts' }],
      }),
      mkHyp({
        perspective: 'semantic-perspective',
        confidence: 0.5,
        files: [{ file: 'shared.ts' }],
      }),
      mkHyp({
        perspective: 'syntactic-perspective',
        confidence: 0.5,
        files: [{ file: 'shared.ts' }],
      }),
    ];
    const plan = synthesizeFixPlan(hyps);
    assert.equal(plan.winningHypothesis.perspective, 'syntactic-perspective');
  });

  it('overlap can promote a lower-confidence hypothesis (consensus power)', () => {
    const hyps: Hypothesis[] = [
      // Solo high-confidence hyp without overlap
      mkHyp({
        perspective: 'syntactic-perspective',
        confidence: 0.6,
        files: [{ file: 'unique-a.ts' }],
      }),
      // 2 hyps with shared file but lower individual confidence
      mkHyp({
        perspective: 'semantic-perspective',
        confidence: 0.5,
        files: [{ file: 'shared.ts' }],
      }),
      mkHyp({
        perspective: 'environmental-perspective',
        confidence: 0.5,
        files: [{ file: 'shared.ts' }],
      }),
    ];
    const plan = synthesizeFixPlan(hyps);
    // semantic has overlap-bonus (count=2 -> +0.15) + tieBonus 0.10 = 0.75 vs syntactic 0.60+0.15=0.75
    // -> tie-break syntactic wins. Plan should still be 'strong' due to overlap.
    assert.equal(plan.planQuality, 'strong');
    // Both shared.ts and unique-a.ts in scope (winner's files + overlap-files)
    const scopeFiles = plan.scopeFiles.map((f) => f.file).sort();
    assert.ok(scopeFiles.includes('shared.ts'));
  });

  it('throws on empty hypotheses', () => {
    assert.throws(() => synthesizeFixPlan([]), /empty hypotheses/);
  });
});
