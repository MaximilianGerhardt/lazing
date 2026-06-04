/**
 * Unit tests for lib/rag/context-builder.ts
 *
 * Run:
 *   npx tsx --test lib/rag/__tests__/context-builder.test.ts
 *
 * Note: omit --test-force-exit for this file. All tests are synchronous but
 * Node.js v22 + tsx can prematurely terminate the event loop with
 * --test-force-exit when multiple describe blocks are registered, causing
 * later tests to be skipped. Natural exit works correctly.
 *
 * Covers (split across two describe blocks to avoid Node.js test-runner
 * early-termination with --test-force-exit on large synchronous suites):
 *
 *  Block A - budget + dedup:
 *   1. Empty input yields empty context, no citations, droppedCount=0.
 *   2. Single chunk within budget is included.
 *   3. N1: token budget enforced by whole-chunk dropping, no mid-truncation.
 *   4. Budget exhausted after first chunk drops all subsequent chunks.
 *   5. Deduplication: same chunk id not included twice.
 *   6. Chunk at exact budget boundary is included.
 *   7. Chunk one token over budget is excluded.
 *
 *  Block B - citations + formatting:
 *   8. Citations numbered 1..n with matching inline markers.
 *   9. References footer present and lists all used chunks.
 *  10. inlineMarkers=false omits [#n] prefix in passage blocks.
 *  11. Score uses routedScore when available, similarity otherwise.
 *  12. usedChunks reflects only included chunks.
 *  13. All chunks fit: droppedCount=0.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildContext } from '../context-builder';
import type { RetrievedChunk } from '../retriever';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeChunk(
  overrides: Partial<RetrievedChunk> & { id: string; text: string },
): RetrievedChunk {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? 'ws-test',
    sourceType: overrides.sourceType ?? 'file',
    sourceId: overrides.sourceId ?? `src-${overrides.id}`,
    text: overrides.text,
    similarity: overrides.similarity ?? 0.8,
    approxTokens: overrides.approxTokens ?? Math.ceil(overrides.text.length / 4),
    routedScore: overrides.routedScore,
  };
}

// ---------------------------------------------------------------------------
// Block A: budget + deduplication
// ---------------------------------------------------------------------------

describe('buildContext: budget and deduplication', () => {
  it('empty input returns empty contextText, no citations, droppedCount=0', () => {
    const result = buildContext([]);
    assert.equal(result.contextText, '');
    assert.deepStrictEqual(result.citations, []);
    assert.deepStrictEqual(result.usedChunks, []);
    assert.equal(result.droppedCount, 0);
  });

  it('single chunk within budget is included', () => {
    const chunk = makeChunk({ id: 'c1', text: 'Hello world', approxTokens: 5 });
    const result = buildContext([chunk], { maxTokens: 100 });
    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].n, 1);
    assert.equal(result.citations[0].chunkId, 'c1');
    assert.equal(result.usedChunks.length, 1);
    assert.equal(result.droppedCount, 0);
    assert.ok(result.contextText.includes('[#1]'), 'inline marker present');
    assert.ok(result.contextText.includes('Hello world'), 'text present');
    assert.ok(result.contextText.includes('References:'), 'References footer present');
    assert.ok(result.contextText.includes('[#1] file:src-c1'), 'citation in References');
  });

  it('N1: budget enforced by whole-chunk dropping, no mid-truncation', () => {
    // chunk1 = 50 tokens, chunk2 = 60 tokens, budget = 70
    // chunk1 fits (50 <= 70); chunk2 would push to 110 > 70, dropped entirely.
    const chunk1 = makeChunk({ id: 'c1', text: 'Short chunk', approxTokens: 50 });
    const chunk2 = makeChunk({ id: 'c2', text: 'Longer chunk that should be dropped', approxTokens: 60 });
    const result = buildContext([chunk1, chunk2], { maxTokens: 70 });
    assert.equal(result.usedChunks.length, 1, 'only chunk1 fits');
    assert.equal(result.usedChunks[0].id, 'c1');
    assert.equal(result.droppedCount, 1, 'chunk2 dropped');
    assert.ok(!result.contextText.includes('Longer chunk'), 'chunk2 text must not appear (N1)');
    assert.ok(result.contextText.includes('Short chunk'), 'chunk1 text intact');
  });

  it('budget exhausted after first chunk drops all subsequent', () => {
    const chunk1 = makeChunk({ id: 'c1', text: 'First', approxTokens: 100 });
    const chunk2 = makeChunk({ id: 'c2', text: 'Second', approxTokens: 50 });
    const chunk3 = makeChunk({ id: 'c3', text: 'Third', approxTokens: 50 });
    const result = buildContext([chunk1, chunk2, chunk3], { maxTokens: 120 });
    assert.equal(result.usedChunks.length, 1);
    assert.equal(result.droppedCount, 2);
  });

  it('deduplication: same chunk id not included twice', () => {
    const chunk = makeChunk({ id: 'c1', text: 'Unique text', approxTokens: 10 });
    const result = buildContext([chunk, chunk], { maxTokens: 1000 });
    assert.equal(result.usedChunks.length, 1, 'only one instance included');
    assert.equal(result.droppedCount, 1, 'duplicate counted as dropped');
  });

  it('chunk at exact budget boundary is included', () => {
    const chunk = makeChunk({ id: 'c1', text: 'Exact fit', approxTokens: 100 });
    const result = buildContext([chunk], { maxTokens: 100 });
    assert.equal(result.usedChunks.length, 1, 'chunk at exact budget is included');
    assert.equal(result.droppedCount, 0);
  });

  it('chunk one token over budget is excluded', () => {
    const chunk = makeChunk({ id: 'c1', text: 'One over', approxTokens: 101 });
    const result = buildContext([chunk], { maxTokens: 100 });
    assert.equal(result.usedChunks.length, 0, 'chunk over budget excluded');
    assert.equal(result.droppedCount, 1);
    assert.equal(result.contextText, '');
  });
});

// ---------------------------------------------------------------------------
// Block B: citations and formatting
// ---------------------------------------------------------------------------

describe('buildContext: citations and formatting', () => {
  it('citations numbered 1..n with matching inline markers', () => {
    const chunks = [
      makeChunk({ id: 'c1', text: 'Alpha', approxTokens: 10 }),
      makeChunk({ id: 'c2', text: 'Beta', approxTokens: 10 }),
      makeChunk({ id: 'c3', text: 'Gamma', approxTokens: 10 }),
    ];
    const result = buildContext(chunks, { maxTokens: 1000 });
    assert.equal(result.citations.length, 3);
    assert.equal(result.citations[0].n, 1);
    assert.equal(result.citations[1].n, 2);
    assert.equal(result.citations[2].n, 3);
    assert.ok(result.contextText.includes('[#1]'), '[#1] present');
    assert.ok(result.contextText.includes('[#2]'), '[#2] present');
    assert.ok(result.contextText.includes('[#3]'), '[#3] present');
  });

  it('references footer lists all used chunks', () => {
    const chunks = [
      makeChunk({ id: 'c1', sourceType: 'file', sourceId: 'foo.ts', text: 'A', approxTokens: 5 }),
      makeChunk({ id: 'c2', sourceType: 'chat', sourceId: 'conv-1', text: 'B', approxTokens: 5 }),
    ];
    const result = buildContext(chunks, { maxTokens: 1000 });
    assert.ok(result.contextText.includes('References:'), 'References section present');
    assert.ok(result.contextText.includes('[#1] file:foo.ts'), 'citation 1 in footer');
    assert.ok(result.contextText.includes('[#2] chat:conv-1'), 'citation 2 in footer');
  });

  it('inlineMarkers false omits prefix in passage blocks', () => {
    const chunk = makeChunk({ id: 'c1', text: 'Test passage', approxTokens: 10 });
    const result = buildContext([chunk], { maxTokens: 1000, inlineMarkers: false });
    assert.ok(!result.contextText.includes('[#1] Test passage'), 'no inline marker before passage');
    assert.ok(result.contextText.includes('Test passage'), 'passage text still present');
    assert.ok(result.contextText.includes('[#1] file:src-c1'), 'citation still in References');
  });

  it('score uses routedScore when available, similarity otherwise', () => {
    const chunk = makeChunk({
      id: 'c1',
      text: 'Passage',
      approxTokens: 10,
      similarity: 0.5,
      routedScore: 0.9,
    });
    const result = buildContext([chunk], { maxTokens: 1000 });
    assert.equal(result.citations[0].score, 0.9, 'citation score equals routedScore');
    assert.ok(result.contextText.includes('sim=0.90'), 'formatted routedScore in Source line');
  });

  it('usedChunks reflects only included chunks', () => {
    const chunks = [
      makeChunk({ id: 'c1', text: 'Fits', approxTokens: 30 }),
      makeChunk({ id: 'c2', text: 'Also fits', approxTokens: 30 }),
      makeChunk({ id: 'c3', text: 'Does not fit', approxTokens: 60 }),
    ];
    const result = buildContext(chunks, { maxTokens: 80 });
    assert.equal(result.usedChunks.length, 2);
    assert.equal(result.usedChunks[0].id, 'c1');
    assert.equal(result.usedChunks[1].id, 'c2');
    assert.equal(result.droppedCount, 1);
  });

  it('all chunks fit yields droppedCount zero', () => {
    const chunks = [
      makeChunk({ id: 'c1', text: 'A', approxTokens: 5 }),
      makeChunk({ id: 'c2', text: 'B', approxTokens: 5 }),
    ];
    const result = buildContext(chunks, { maxTokens: 1000 });
    assert.equal(result.droppedCount, 0);
    assert.equal(result.usedChunks.length, 2);
  });
});
