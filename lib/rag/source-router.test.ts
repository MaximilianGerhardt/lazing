/**
 * Source-Router-Tests (Pattern 3 MVP).
 *
 * Run: `pnpm exec tsx --test lib/rag/source-router.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { applyRouting, classify, type QueryIntent, type RouterHit } from './source-router';

describe('classify', () => {
  it('classifies code-intent queries', () => {
    const queries = [
      'wie funktioniert der indexer',
      'fix the TypeError in retriever.ts',
      'refactor this class',
      'implement export function',
    ];
    for (const q of queries) {
      assert.equal(classify(q), 'code', `Query "${q}" should be 'code'`);
    }
  });

  it('classifies status-intent queries', () => {
    const queries = [
      'wo stehen wir mit dem ticket',
      'sprint status update',
      'welche tasks sind blocked',
      'was ist offen im work-product',
    ];
    for (const q of queries) {
      assert.equal(classify(q), 'status', `Query "${q}" should be 'status'`);
    }
  });

  it('classifies history-intent queries', () => {
    const queries = [
      'warum haben wir damals X entschieden',
      'gestern haben wir besprochen',
      'was wurde letzte woche gesagt',
      'die entscheidung im chat',
    ];
    for (const q of queries) {
      assert.equal(classify(q), 'history', `Query "${q}" should be 'history'`);
    }
  });

  it('falls back to unknown for unmatched queries', () => {
    const queries = ['Lorem Ipsum', 'asdf qwer', 'foo bar baz', 'x y z'];
    for (const q of queries) {
      assert.equal(classify(q), 'unknown', `Query "${q}" should be 'unknown'`);
    }
  });
});

describe('applyRouting', () => {
  const hits: RouterHit[] = [
    { sourceType: 'file', similarity: 0.7 },
    { sourceType: 'chat', similarity: 0.7 },
    { sourceType: 'ticket', similarity: 0.7 },
    { sourceType: 'work-product', similarity: 0.7 },
    { sourceType: 'file', similarity: 0.5 },
    { sourceType: 'chat', similarity: 0.5 },
    { sourceType: 'ticket', similarity: 0.5 },
    { sourceType: 'work-product', similarity: 0.5 },
  ];

  it('boosts files for code-intent', () => {
    const ranked = applyRouting(hits, 'code')
      .slice()
      .sort((a, b) => b.routedScore - a.routedScore);
    // file@0.7 * 1.30 = 0.91 — top
    assert.equal(ranked[0].sourceType, 'file');
    assert.ok(ranked[0].routedScore > 0.9 && ranked[0].routedScore < 0.92);
  });

  it('boosts tickets for status-intent', () => {
    const ranked = applyRouting(hits, 'status')
      .slice()
      .sort((a, b) => b.routedScore - a.routedScore);
    // ticket@0.7 * 1.30 = 0.91 — top
    assert.equal(ranked[0].sourceType, 'ticket');
    // file@0.7 * 0.80 = 0.56 — should be downranked
    const fileTop = ranked.find((r) => r.sourceType === 'file' && r.similarity === 0.7);
    assert.ok(fileTop && fileTop.routedScore < 0.6);
  });

  it('boosts chat for history-intent', () => {
    const ranked = applyRouting(hits, 'history')
      .slice()
      .sort((a, b) => b.routedScore - a.routedScore);
    // chat@0.7 * 1.30 = 0.91 — top
    assert.equal(ranked[0].sourceType, 'chat');
  });

  it('preserves order for unknown-intent (all weights = 1.0)', () => {
    const routed = applyRouting(hits, 'unknown');
    for (const r of routed) {
      assert.equal(r.routedScore, r.similarity);
    }
  });

  it('falls back to weight 1.0 for unrecognized sourceType', () => {
    const odd: RouterHit[] = [{ sourceType: 'something-weird', similarity: 0.5 }];
    const routed = applyRouting(odd, 'code');
    assert.equal(routed[0].routedScore, 0.5);
  });

  it('preserves all original fields on hit', () => {
    type ExtHit = RouterHit & { id: string; extra: number };
    const ext: ExtHit[] = [{ sourceType: 'file', similarity: 0.5, id: 'abc', extra: 42 }];
    const routed = applyRouting(ext, 'code');
    assert.equal(routed[0].id, 'abc');
    assert.equal(routed[0].extra, 42);
    assert.equal(routed[0].sourceType, 'file');
    assert.equal(routed[0].similarity, 0.5);
    assert.ok(typeof routed[0].routedScore === 'number');
  });
});

describe('QueryIntent type-coverage', () => {
  it('exposes the four intents', () => {
    const all: QueryIntent[] = ['code', 'status', 'history', 'unknown'];
    assert.equal(all.length, 4);
  });
});
