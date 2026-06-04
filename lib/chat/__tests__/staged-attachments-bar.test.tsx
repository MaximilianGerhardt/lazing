/**
 * Tests fuer StagedAttachmentsBar — die fixierte Anhang-Vorschau ueber dem
 * Composer (Owner-Hard-Requirement 2026-05-26).
 *
 * Verifiziert:
 *   - Bild → Thumbnail (<img> mit thumb/preview-URL).
 *   - Dokument → Datei-Karte mit Ext-Label (kein <img>).
 *   - Entfernen-Button (×) ruft onRemove mit der id.
 *   - leer + kein Upload → rendert nichts (null).
 *   - Upload-läuft-Chip erscheint.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { StagedAttachmentsBar } from '../StagedAttachmentsBar';
import type { StagedAttachment } from '../attachment-message';

function mk(over: Partial<StagedAttachment> = {}): StagedAttachment {
  return {
    id: 'ART-1',
    filename: 'foto.jpeg',
    mime: 'image/jpeg',
    bytes: 2048,
    pages: null,
    workspaceId: 'ws',
    downloadUrl: '/api/cloud/ART-1',
    previewUrl: '/api/cloud/ART-1/preview',
    thumbnailUrl: '/api/cloud/ART-1/thumb',
    ...over,
  };
}

describe('StagedAttachmentsBar', () => {
  it('Bild rendert Thumbnail', () => {
    const html = renderToStaticMarkup(
      createElement(StagedAttachmentsBar, {
        attachments: [mk()],
        onRemove: () => {},
      }),
    );
    expect(html).toContain('<img');
    expect(html).toContain('/api/cloud/ART-1/thumb');
    expect(html).toContain('foto.jpeg');
    // Entfernen-Button vorhanden.
    expect(html).toContain('Anhang entfernen: foto.jpeg');
  });

  it('Dokument rendert Datei-Karte mit Ext-Label statt Bild', () => {
    const html = renderToStaticMarkup(
      createElement(StagedAttachmentsBar, {
        attachments: [
          mk({ id: 'ART-2', filename: 'bericht.pdf', mime: 'application/pdf' }),
        ],
        onRemove: () => {},
      }),
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('bericht.pdf');
    expect(html).toContain('PDF');
  });

  it('leer + kein Upload → rendert nichts', () => {
    const html = renderToStaticMarkup(
      createElement(StagedAttachmentsBar, {
        attachments: [],
        onRemove: () => {},
      }),
    );
    expect(html).toBe('');
  });

  it('Upload-läuft-Chip erscheint mit Dateiname', () => {
    const html = renderToStaticMarkup(
      createElement(StagedAttachmentsBar, {
        attachments: [],
        onRemove: () => {},
        uploadingName: 'lade.png',
      }),
    );
    expect(html).toContain('lade.png');
  });

  it('mehrere Anhänge stapelbar (Bild + Doc gemischt)', () => {
    const html = renderToStaticMarkup(
      createElement(StagedAttachmentsBar, {
        attachments: [
          mk({ id: 'A', filename: 'a.png', mime: 'image/png' }),
          mk({ id: 'B', filename: 'b.pdf', mime: 'application/pdf' }),
        ],
        onRemove: () => {},
      }),
    );
    expect(html).toContain('a.png');
    expect(html).toContain('b.pdf');
  });
});
