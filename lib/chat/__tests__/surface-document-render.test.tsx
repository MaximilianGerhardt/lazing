/**
 * Tests fuer die Dokument-Surface im gespeicherten/gestreamten Chat-Render-Pfad.
 *
 * Owner-Bug (2026-05-26): Der Agent emittiert
 *   <surface:document>{"filename":"ref-example-agency-de.md","mime":"text/markdown",
 *                       "workspace":"example-website-project"}</surface:document>
 * und es erschien als ROHTEXT statt als Dokument-Karte.
 *
 * Root-Cause: `renderDocument` (SurfaceRenderer) verlangte ein `id`-Feld und
 * gab sonst `null` zurueck. Der synchrone Render-Pfad `renderChatText`
 * (surface-text-render) faellt bei `null` auf den Roh-Tag zurueck → Rohtext.
 *
 * Fix-Verifikation:
 *   1) Minimal-Payload (filename/mime/workspace, KEIN id) → rendert Karte,
 *      NICHT den rohen `<surface:document>`-Tag.
 *   2) Voll-Payload aus echtem Upload (mit id + image-mime) → rendert
 *      Bild-Bubble (Inline-Cover via previewUrl).
 *   3) Doc-Payload mit id (PDF) → rendert Datei-Karte mit Download/Preview.
 *   4) renderSurface('document', …) direkt ist tolerant gegen fehlende id.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { renderChatText } from '../surface-text-render';
import { renderSurface } from '../SurfaceRenderer';

function markupOf(node: React.ReactNode): string {
  // renderChatText liefert ReactNode[] — in ein Fragment wrappen.
  return renderToStaticMarkup(createElement('div', null, node));
}

// Mini-Assert-Shim, damit die bestehenden assert-Aufrufe unter vitest laufen.
const assert = {
  ok(cond: unknown, msg?: string): void {
    expect(cond, msg).toBeTruthy();
  },
  equal(a: unknown, b: unknown, msg?: string): void {
    expect(a, msg).toBe(b);
  },
  notEqual(a: unknown, b: unknown, msg?: string): void {
    expect(a, msg).not.toBe(b);
  },
};

describe('surface:document — stored-message render path', () => {
  it('Minimal-Agent-Payload (kein id) rendert Karte statt Rohtext', () => {
    const text =
      'Hier ist die Referenz:\n' +
      '<surface:document>' +
      JSON.stringify({
        filename: 'ref-example-agency-de.md',
        mime: 'text/markdown',
        workspace: 'example-website-project',
      }) +
      '</surface:document>';

    const html = markupOf(renderChatText(text));

    // Der Dateiname erscheint in der Karte …
    assert.ok(
      html.includes('ref-example-agency-de.md'),
      'filename should be rendered in the card',
    );
    // … aber der ROHE Tag darf NICHT mehr im Output stehen.
    assert.ok(
      !html.includes('&lt;surface:document&gt;') &&
        !html.includes('<surface:document>'),
      'raw <surface:document> tag must not leak into output',
    );
    // Die JSON-Payload als Rohtext (opacity-0.6-Fallback) darf nicht da sein.
    assert.ok(
      !html.includes('"workspace":"example-website-project"'),
      'raw JSON payload must not be rendered as fallback text',
    );
    // MIME-Label MD (Markdown) erscheint als Datei-Typ-Pill.
    assert.ok(html.includes('MD'), 'mime label MD should appear');
  });

  it('Voll-Upload-Payload (image + id) rendert Bild-Bubble mit Inline-Cover', () => {
    const text =
      '<surface:document>' +
      JSON.stringify({
        id: 'ART-01KSJ048JRQGT94YMCQ7JDEY1H',
        filename: 'foto.jpeg',
        mime: 'image/jpeg',
        bytes: 1291509,
        workspace: '__org_root__:example-company',
        workspaceLabel: 'Example Company',
        downloadUrl: '/api/cloud/ART-01KSJ048JRQGT94YMCQ7JDEY1H',
        previewUrl: '/api/cloud/ART-01KSJ048JRQGT94YMCQ7JDEY1H/preview',
        thumbnailUrl: '/api/cloud/ART-01KSJ048JRQGT94YMCQ7JDEY1H/thumb',
      }) +
      '</surface:document>';

    const html = markupOf(renderChatText(text));

    // Bild-Cover via previewUrl (img src).
    assert.ok(
      html.includes('/api/cloud/ART-01KSJ048JRQGT94YMCQ7JDEY1H/preview'),
      'image cover should reference the preview URL',
    );
    assert.ok(html.includes('<img'), 'image bubble should render an <img>');
    assert.ok(
      !html.includes('<surface:document>'),
      'raw tag must not leak',
    );
  });

  it('Doc-Payload (PDF + id) rendert Datei-Karte mit Download-Aktion', () => {
    const text =
      '<surface:document>' +
      JSON.stringify({
        id: 'ART-PDF123',
        filename: 'Tagesbericht.pdf',
        mime: 'application/pdf',
        bytes: 204800,
        pages: 3,
        downloadUrl: '/api/cloud/ART-PDF123',
      }) +
      '</surface:document>';

    const html = markupOf(renderChatText(text));

    assert.ok(html.includes('Tagesbericht.pdf'), 'filename rendered');
    assert.ok(html.includes('PDF'), 'PDF mime label rendered');
    assert.ok(html.includes('200 KB'), 'size rendered');
    assert.ok(html.includes('3 Seiten'), 'page count rendered');
    // Download-Button (aria-label) ist vorhanden weil id existiert.
    assert.ok(
      html.includes('Download Tagesbericht.pdf'),
      'download action present when id exists',
    );
    assert.ok(!html.includes('<surface:document>'), 'raw tag must not leak');
  });

  it('renderSurface("document", …) ist tolerant gegen fehlende id', () => {
    const withId = renderSurface('document', {
      id: 'ART-X',
      filename: 'a.pdf',
      mime: 'application/pdf',
    });
    const withoutId = renderSurface('document', {
      filename: 'b.md',
      mime: 'text/markdown',
      workspace: 'ws',
    });
    assert.notEqual(withId, null, 'document with id renders');
    assert.notEqual(
      withoutId,
      null,
      'document WITHOUT id must still render (no null → no raw-text fallback)',
    );
  });

  it('Ohne filename rendert NICHT (nichts Sinnvolles zu zeigen)', () => {
    const out = renderSurface('document', { mime: 'application/pdf' });
    assert.equal(out, null, 'no filename → null is acceptable');
  });
});
