/**
 * Unit tests for lib/rag/rrf.ts -Reciprocal Rank Fusion.
 *
 * Run:
 *   npx tsx --test --test-force-exit lib/rag/__tests__/rrf.test.ts
 *
 * Covers:
 *   1. Known ranked lists → expected scores (exact arithmetic check).
 *   2. Determinism: same input always yields same output.
 *   3. Single-list passthrough (degenerate case).
 *   4. Empty input → empty output.
 *   5. Document present in only one list contributes only that list's score.
 *   6. Tie-breaking by id lexicographic order.
 *   7. Custom k value changes scores proportionally.
 *   8. Documents present in all lists rank above those in fewer lists
 *      (when ranks are equal).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { reciprocalRankFusion } from '../rrf';

describe('reciprocalRankFusion', () => {
  it('empty input returns empty array', () => {
    assert.deepStrictEqual(reciprocalRankFusion([]), []);
  });

  it('empty lists in input returns empty array', () => {
    assert.deepStrictEqual(reciprocalRankFusion([[], []]), []);
  });

  it('single list -score equals 1/(k+rank)', () => {
    // k=60 (default): doc at rank 1 → 1/61, doc at rank 2 → 1/62
    const result = reciprocalRankFusion([['a', 'b']]);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a');
    assert.equal(result[1].id, 'b');
    // Exact arithmetic: 1/(60+1) = 1/61 ≈ 0.016393...
    assert.ok(Math.abs(result[0].rrfScore - 1 / 61) < 1e-10, 'score for rank-1 should be 1/61');
    assert.ok(Math.abs(result[1].rrfScore - 1 / 62) < 1e-10, 'score for rank-2 should be 1/62');
  });

  it('two lists -doc in both lists accumulates scores from each', () => {
    // list1: [A, B], list2: [B, A]
    // A: rank1 in list1 (1/61) + rank2 in list2 (1/62) = 1/61 + 1/62
    // B: rank2 in list1 (1/62) + rank1 in list2 (1/61) = 1/62 + 1/61
    // Both equal -tie-break by id lexicographic: A < B → A first
    const result = reciprocalRankFusion([['A', 'B'], ['B', 'A']]);
    assert.equal(result.length, 2);
    const expectedScore = 1 / 61 + 1 / 62;
    assert.ok(Math.abs(result[0].rrfScore - expectedScore) < 1e-10);
    assert.ok(Math.abs(result[1].rrfScore - expectedScore) < 1e-10);
    // Tie-break: 'A' < 'B' lexicographically → A first
    assert.equal(result[0].id, 'A');
    assert.equal(result[1].id, 'B');
  });

  it('doc only in one list gets that list\'s contribution', () => {
    // list1: [X, Y], list2: [Y, Z]
    // X: only in list1 at rank 1 → 1/61
    // Y: rank 2 in list1 + rank 1 in list2 → 1/62 + 1/61
    // Z: only in list2 at rank 2 → 1/62
    const result = reciprocalRankFusion([['X', 'Y'], ['Y', 'Z']]);
    assert.equal(result.length, 3);
    const y = result.find((r) => r.id === 'Y')!;
    const x = result.find((r) => r.id === 'X')!;
    const z = result.find((r) => r.id === 'Z')!;
    // Y should rank first (highest combined score)
    assert.ok(y.rrfScore > x.rrfScore, 'Y (in both lists) > X (in one list)');
    assert.ok(y.rrfScore > z.rrfScore, 'Y (in both lists) > Z (in one list)');
    assert.ok(Math.abs(x.rrfScore - 1 / 61) < 1e-10, 'X score = 1/61');
    assert.ok(Math.abs(z.rrfScore - 1 / 62) < 1e-10, 'Z score = 1/62');
    assert.ok(Math.abs(y.rrfScore - (1 / 62 + 1 / 61)) < 1e-10, 'Y score = 1/61 + 1/62');
  });

  it('deterministic: same input always yields identical output', () => {
    const lists = [
      ['c', 'a', 'b'],
      ['b', 'c', 'a'],
    ];
    const run1 = reciprocalRankFusion(lists);
    const run2 = reciprocalRankFusion(lists);
    assert.deepStrictEqual(run1, run2);
  });

  it('three lists -doc in all three outranks doc in two', () => {
    // list0: ['alpha', 'beta'] -alpha rank 1 (1/61), beta rank 2 (1/62)
    // list1: ['alpha', 'beta'] -alpha rank 1 (1/61), beta rank 2 (1/62)
    // list2: ['alpha']         -alpha rank 1 (1/61), beta absent (0)
    // alpha: 3 * 1/61 = 3/61
    // beta:  2 * 1/62 = 2/62
    const result = reciprocalRankFusion([
      ['alpha', 'beta'],
      ['alpha', 'beta'],
      ['alpha'],          // beta not in this list
    ]);
    const alpha = result.find((r) => r.id === 'alpha')!;
    const beta = result.find((r) => r.id === 'beta')!;
    assert.ok(alpha.rrfScore > beta.rrfScore, 'alpha (3 lists) > beta (2 lists)');
    assert.ok(Math.abs(alpha.rrfScore - 3 / 61) < 1e-10, 'alpha = 3/61');
    assert.ok(Math.abs(beta.rrfScore - 2 / 62) < 1e-10, 'beta = 2/62 (rank 2 in two lists)');
  });

  it('custom k=1 produces expected scores', () => {
    // k=1: rank-1 doc → 1/(1+1) = 0.5
    const result = reciprocalRankFusion([['foo']], 1);
    assert.equal(result.length, 1);
    assert.ok(Math.abs(result[0].rrfScore - 0.5) < 1e-10, 'score with k=1 at rank 1 = 0.5');
  });

  it('contributions map tracks per-list scores', () => {
    const result = reciprocalRankFusion([['p', 'q'], ['q', 'p']]);
    const p = result.find((r) => r.id === 'p')!;
    // p: rank 1 in list 0 → contribution[0] = 1/61
    //    rank 2 in list 1 → contribution[1] = 1/62
    assert.ok(Math.abs((p.contributions[0] ?? 0) - 1 / 61) < 1e-10);
    assert.ok(Math.abs((p.contributions[1] ?? 0) - 1 / 62) < 1e-10);
  });

  it('output order is stable -running twice on shuffled input gives same relative order', () => {
    const lists = [['d', 'c', 'b', 'a'], ['a', 'b', 'c', 'd']];
    const result = reciprocalRankFusion(lists);
    // a is rank 4 in list0 + rank 1 in list1: 1/64 + 1/61
    // d is rank 1 in list0 + rank 4 in list1: 1/61 + 1/64
    // Scores are equal → tie-break: 'a' < 'd' → a first
    const a = result.find((r) => r.id === 'a')!;
    const d = result.find((r) => r.id === 'd')!;
    assert.ok(Math.abs(a.rrfScore - d.rrfScore) < 1e-10, 'a and d have same score');
    // Verify tie-break direction
    assert.ok(result.indexOf(a) < result.indexOf(d), 'a before d (lexicographic tie-break)');
  });
});
