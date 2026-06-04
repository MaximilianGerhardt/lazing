/**
 * Tests für source-chip + source-chip-row (P11, 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/chat/__tests__/source-chip.test.tsx`
 *
 * Fokus:
 *   1. shortenRef-Logik (file-Pfad-Verkürzung, lange refs)
 *   2. normalizeAuditSources — kombiniert sourceChunks + priorOutputs zu Items
 *   3. SSR-Smoke-Test: SourceChip rendert in HTML, kind-Glyphen drin
 *   4. SSR-Smoke-Test: SourceChipRow zeigt 5+more Trigger bei 7 Items
 *
 * KEINE Browser-DOM-Tests — wir haben keine Test-Library installiert. Wir
 * testen Pure-Logic + SSR-Output via renderToStaticMarkup.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { shortenRef, SourceChip } from '../source-chip';
import { normalizeAuditSources, SourceChipRow } from '../source-chip-row';

// ────────────────────────────── shortenRef ──────────────────────────────

describe('shortenRef', () => {
  it('verkürzt file-Pfade auf den Basename', () => {
    assert.equal(
      shortenRef('file:/srv/projects/app/src/foo/bar.ts'),
      'file:bar.ts',
    );
    assert.equal(shortenRef('file:relative/x.tsx'), 'file:x.tsx');
  });

  it('lässt kurze refs unverändert', () => {
    assert.equal(shortenRef('ticket:tck_abc'), 'ticket:tck_abc');
    assert.equal(shortenRef('phase:v2:hash123'), 'phase:v2:hash123');
  });

  it('kürzt sehr lange refs mit Ellipsis', () => {
    const longRef = 'phase:v2:' + 'a'.repeat(100);
    const out = shortenRef(longRef);
    assert.ok(out.endsWith('…'), `expected ellipsis suffix, got: ${out}`);
    assert.ok(out.length <= 32, `expected ≤32 chars, got ${out.length}`);
  });
});

// ────────────────────────────── normalizeAuditSources ──────────────────────────────

describe('normalizeAuditSources', () => {
  it('kombiniert sourceChunks + priorOutputs zu items', () => {
    const items = normalizeAuditSources({
      id: 'a1',
      sourceChunks: [
        {
          sourceType: 'file',
          sourceId: 'lib/foo.ts',
          text: 'Hallo Welt',
          similarity: 0.92,
        },
        {
          sourceType: 'ticket',
          sourceId: 'tck_x',
          text: 'Ticket-Body',
        },
      ],
      priorOutputs: [{ phase: 'v1', hash: 'abcdef0123', text: 'V1-Output' }],
    });

    assert.equal(items.length, 3);
    assert.equal(items[0].kind, 'rag');
    assert.equal(items[0].ref, 'file:lib/foo.ts');
    assert.equal(items[0].similarity, 0.92);
    assert.equal(items[1].kind, 'rag');
    assert.equal(items[1].ref, 'ticket:tck_x');
    assert.equal(items[2].kind, 'prior-output');
    assert.equal(items[2].ref, 'phase:v1:abcdef01');
  });

  it('truncated snippet bei langem text', () => {
    const longText = 'x'.repeat(500);
    const items = normalizeAuditSources({
      id: 'a1',
      sourceChunks: [
        { sourceType: 'file', sourceId: 'a', text: longText },
      ],
    });
    assert.equal(items.length, 1);
    assert.ok(
      items[0].snippet.length <= 300,
      `expected snippet ≤300, got ${items[0].snippet.length}`,
    );
    assert.ok(items[0].snippet.endsWith('…'));
  });

  it('liefert leeres Array für leere row', () => {
    const items = normalizeAuditSources({ id: 'a1' });
    assert.deepEqual(items, []);
  });

  it('fail-soft bei fehlenden Feldern in chunks/priors', () => {
    const items = normalizeAuditSources({
      id: 'a1',
      sourceChunks: [{ text: 'no-source-id' }],
      priorOutputs: [{ phase: 'v2' }],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, 'rag');
    assert.ok(items[0].ref.startsWith('rag:'));
    assert.equal(items[1].kind, 'prior-output');
    assert.ok(items[1].ref.startsWith('phase:v2:'));
  });
});

// ────────────────────────────── SourceChip SSR ──────────────────────────────

describe('SourceChip SSR', () => {
  it('rendert kind=rag mit Diamant-Icon', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, { kind: 'rag', ref: 'file:foo.ts' }),
    );
    assert.ok(html.includes('RAG'), `missing RAG label in: ${html}`);
    assert.ok(html.includes('◆'), `missing diamond glyph in: ${html}`);
  });

  it('rendert kind=prior-output mit ↳-Icon', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, {
        kind: 'prior-output',
        ref: 'phase:v2:hash123',
      }),
    );
    assert.ok(html.includes('Prior'));
    assert.ok(html.includes('↳'));
  });

  it('rendert kind=memory mit ◉-Icon', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, { kind: 'memory', ref: 'mem:user-pref-1' }),
    );
    assert.ok(html.includes('Memory'));
    assert.ok(html.includes('◉'));
  });

  it('rendert similarity-Badge wenn gesetzt', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, {
        kind: 'rag',
        ref: 'file:x.ts',
        similarity: 0.876,
      }),
    );
    assert.ok(html.includes('88%'), `expected 88% in html: ${html}`);
  });

  it('onClick macht aus chip einen <button>', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, {
        kind: 'rag',
        ref: 'file:x.ts',
        onClick: (): void => {},
      }),
    );
    assert.ok(html.startsWith('<button'), `expected <button>, got ${html}`);
  });

  it('ohne onClick rendert als <span>', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChip, { kind: 'rag', ref: 'file:x.ts' }),
    );
    assert.ok(html.startsWith('<span'), `expected <span>, got ${html}`);
  });
});

// ────────────────────────────── SourceChipRow SSR ──────────────────────────────

describe('SourceChipRow SSR', () => {
  it('zeigt 5 Chips + "+2 weitere" bei 7 sources', () => {
    const auditRow = {
      id: 'audit-1',
      sourceChunks: Array.from({ length: 7 }, (_, i) => ({
        sourceType: 'file',
        sourceId: `chunk-${i}`,
        text: `chunk-text-${i}`,
        similarity: 0.5 + i * 0.05,
      })),
    };
    const html = renderToStaticMarkup(
      createElement(SourceChipRow, { auditRow }),
    );
    // 5 chip-buttons → suchen nach data-testid
    const chipMatches = html.match(/data-testid="source-chip-rag"/g) ?? [];
    assert.equal(chipMatches.length, 5, `expected 5 chips, got ${chipMatches.length}`);
    assert.ok(html.includes('+2 weitere'), `expected +2 weitere, got: ${html}`);
  });

  it('kein Render bei leerer row', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChipRow, {
        auditRow: { id: 'a' },
      }),
    );
    assert.equal(html, '', `expected empty render, got: ${html}`);
  });

  it('rendert mixed kinds (rag + prior-output)', () => {
    const auditRow = {
      id: 'audit-2',
      sourceChunks: [
        { sourceType: 'file', sourceId: 'a.ts', text: 'a' },
        { sourceType: 'ticket', sourceId: 'tck_1', text: 'b' },
      ],
      priorOutputs: [{ phase: 'v1', hash: 'h1', text: 'prior' }],
    };
    const html = renderToStaticMarkup(
      createElement(SourceChipRow, { auditRow }),
    );
    assert.ok(html.includes('data-testid="source-chip-rag"'));
    assert.ok(html.includes('data-testid="source-chip-prior-output"'));
  });

  it('Lead-Label "Quellen:" präsent', () => {
    const html = renderToStaticMarkup(
      createElement(SourceChipRow, {
        auditRow: {
          id: 'a',
          sourceChunks: [{ sourceType: 'file', sourceId: 'x', text: 'y' }],
        },
      }),
    );
    assert.ok(html.includes('Quellen'));
  });
});
