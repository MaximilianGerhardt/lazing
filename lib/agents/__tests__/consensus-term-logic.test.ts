/**
 * Tests für lib/agents/consensus-term-logic.ts (Welle 3c, 2026-05-03).
 *
 * Run: `pnpm exec tsx --test lib/agents/__tests__/consensus-term-logic.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { aggregateTerms, similarity } from '../consensus-term-logic';

describe('aggregateTerms', () => {
  it('empty input → empty result', () => {
    const r = aggregateTerms([]);
    assert.deepEqual(r, { agreedTerms: [], conflictClusters: [], outliers: [] });
  });

  it('single roaster, single confident term → no agreement, no outlier (drop)', () => {
    const r = aggregateTerms([
      [{ claim: 'Plan needs better risk-section', basis: 'sec-3', confidence: 0.9 }],
    ]);
    assert.equal(r.agreedTerms.length, 0);
    assert.equal(r.outliers.length, 0);
  });

  it('two roasters agreeing → 1 agreedTerm', () => {
    const r = aggregateTerms([
      [{ claim: 'Plan lacks risk-section', basis: 'r1', confidence: 0.8 }],
      [{ claim: 'Plan lacks risk-section', basis: 'r2', confidence: 0.7 }],
    ]);
    assert.equal(r.agreedTerms.length, 1);
    assert.equal(r.agreedTerms[0].voteCount, 2);
    assert.ok(r.agreedTerms[0].avgConfidence > 0.7);
    assert.deepEqual(r.agreedTerms[0].basisMerged, ['r1', 'r2']);
  });

  it('three roasters, similarity grouping (paraphrased) → still 1 group', () => {
    const r = aggregateTerms([
      [{ claim: 'plan lacks risk section', basis: 'r1', confidence: 0.8 }],
      [{ claim: 'plan lacks risk section ', basis: 'r2', confidence: 0.8 }],
      [{ claim: 'plan lacks risk section!', basis: 'r3', confidence: 0.8 }],
    ]);
    assert.equal(r.agreedTerms.length, 1);
    assert.equal(r.agreedTerms[0].voteCount, 3);
  });

  it('explicit conflict (conflictsWith id) → conflictCluster', () => {
    const r = aggregateTerms([
      [
        {
          id: 'a1',
          claim: 'Use SQLite for the embedded local store',
          basis: 'simplicity, single-binary',
          confidence: 0.9,
        },
      ],
      [
        {
          id: 'b1',
          claim: 'Switch to Postgres so we can scale horizontally',
          basis: 'multi-tenant scale',
          confidence: 0.85,
          conflictsWith: ['a1'],
        },
      ],
    ]);
    assert.equal(r.conflictClusters.length, 1);
    assert.match(r.conflictClusters[0].reason, /conflict declared/);
  });

  it('low-confidence single-roaster claim → outlier', () => {
    const r = aggregateTerms([
      [{ claim: 'Edge-case nobody saw', basis: 'gut-feel', confidence: 0.3 }],
    ]);
    assert.equal(r.outliers.length, 1);
    assert.equal(r.outliers[0].claim, 'Edge-case nobody saw');
  });

  it('basis merge dedupes equal strings', () => {
    const r = aggregateTerms([
      [{ claim: 'Add tests', basis: 'standard practice', confidence: 0.8 }],
      [{ claim: 'Add tests', basis: 'standard practice', confidence: 0.8 }],
    ]);
    assert.equal(r.agreedTerms[0].basisMerged.length, 1);
  });

  it('handles edge: empty claim string → grouped together as same', () => {
    const r = aggregateTerms([
      [{ claim: '', basis: 'r1', confidence: 0.6 }],
      [{ claim: '', basis: 'r2', confidence: 0.6 }],
    ]);
    assert.equal(r.agreedTerms.length, 1);
    assert.equal(r.agreedTerms[0].voteCount, 2);
  });
});

describe('similarity', () => {
  it('identical strings → 1', () => {
    assert.equal(similarity('foo bar', 'foo bar'), 1);
  });
  it('totally different → < 0.3', () => {
    assert.ok(similarity('xxxx', 'yyyy') < 0.3);
  });
  it('case + whitespace insensitive', () => {
    assert.ok(similarity('FOO ', 'foo') >= 0.99);
  });
});
