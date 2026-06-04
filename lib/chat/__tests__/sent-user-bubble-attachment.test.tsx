/**
 * Tests fuer die ANZEIGE eines Anhangs in der GESENDETEN User-Bubble.
 *
 * Follow-up-Bug (Owner, 2026-05-26, live nach Rebuild): Staging über dem
 * Input ✅, aber NACH dem Absenden war der Anhang in der User-Bubble
 * UNSICHTBAR (kein Thumbnail / keine Datei-Karte).
 *
 * Root-Cause: Der User-Bubble-Render-Pfad (MsgUser) rendert `it.content`
 * als ROHEN String — KEIN Surface-Parsing (nur der Assistant-Pfad parste
 * Surfaces). Das `<surface:document>`-Markup blieb literaler Text.
 *
 * Fix: Die User-Bubble routet Content mit Surfaces über denselben
 * surface-aware Renderer (`renderChatText`) wie der Assistant — gated auf
 * `parseHistoryItem(...).surfaces.length > 0`, damit reine Text-Messages
 * unverändert (raw) bleiben.
 *
 * Diese Tests prüfen die REALE Bubble-Pipeline:
 *   buildBubbleContent(...) → parseHistoryItem(...).surfaces (Gate) →
 *   renderChatText(content, surfaces) (Render).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { renderChatText } from '../surface-text-render';
import { parseHistoryItem } from '../replace-logic';
import { buildBubbleContent, type StagedAttachment } from '../attachment-message';

function markupOf(node: React.ReactNode): string {
  return renderToStaticMarkup(createElement('div', null, node));
}

function imageAttachment(): StagedAttachment {
  return {
    id: 'ART-IMG9',
    filename: 'screenshot.png',
    mime: 'image/png',
    bytes: 84211,
    pages: null,
    workspaceId: 'demo-workspace',
    workspaceLabel: 'Demo Workspace',
    downloadUrl: '/api/cloud/ART-IMG9',
    previewUrl: '/api/cloud/ART-IMG9/preview',
    thumbnailUrl: '/api/cloud/ART-IMG9/thumb',
    storagePath: 'demo-workspace/ART-IMG9',
    absPath: '/tmp/lazyos-test/.lazyos/cloud/demo-workspace/ART-IMG9',
  };
}

function docAttachment(): StagedAttachment {
  return {
    id: 'ART-DOC9',
    filename: 'angebot.pdf',
    mime: 'application/pdf',
    bytes: 512000,
    pages: 4,
    workspaceId: 'demo-workspace',
    workspaceLabel: 'Demo Workspace',
    downloadUrl: '/api/cloud/ART-DOC9',
    previewUrl: '/api/cloud/ART-DOC9/preview',
    thumbnailUrl: '/api/cloud/ART-DOC9/thumb',
    storagePath: 'demo-workspace/ART-DOC9',
    absPath: '/tmp/lazyos-test/.lazyos/cloud/demo-workspace/ART-DOC9',
  };
}

/**
 * Spiegelt die ChatShell-User-Bubble-Logik: gate auf parsedSurfaces, sonst
 * raw. Hält den Test an den exakten Render-Pfad gekoppelt.
 */
function renderUserBubble(content: string): string {
  const parsed = parseHistoryItem({
    id: 'u1',
    role: 'user',
    content,
    ts: new Date().toISOString(),
  });
  const hasSurfaces = parsed.surfaces.length > 0;
  const node = hasSurfaces
    ? renderChatText(content, parsed.surfaces)
    : content;
  return markupOf(node);
}

describe('sent user bubble · Bild-Anhang', () => {
  const content = buildBubbleContent(
    [imageAttachment()],
    'Schau dir das mal an',
  );

  it('Gate erkennt Surfaces (würde renderChatText nutzen, nicht raw)', () => {
    const parsed = parseHistoryItem({
      id: 'u1',
      role: 'user',
      content,
      ts: new Date().toISOString(),
    });
    expect(parsed.surfaces.length).toBe(1);
    expect(parsed.surfaces[0]!.kind).toBe('document');
  });

  it('rendert ein <img>-Thumbnail (NICHT Rohtext)', () => {
    const html = renderUserBubble(content);
    expect(html).toContain('<img');
    // Bild-Cover via previewUrl (image-mime → previewUrl).
    expect(html).toContain('/api/cloud/ART-IMG9/preview');
    // Roh-Tag darf NICHT geleakt sein.
    expect(html).not.toContain('<surface:document>');
    expect(html).not.toContain('&lt;surface:document&gt;');
    // Caption ist mit dabei.
    expect(html).toContain('Schau dir das mal an');
  });

  it('Bild-Cover ist klickbar (Lightbox-Button)', () => {
    const html = renderUserBubble(content);
    expect(html.toLowerCase()).toContain('bild öffnen');
  });
});

describe('sent user bubble · Dokument-Anhang', () => {
  const content = buildBubbleContent([docAttachment()], 'Bitte prüfen');

  it('rendert Datei-Karte mit Name, Größe, Seiten und Download', () => {
    const html = renderUserBubble(content);
    expect(html).toContain('angebot.pdf');
    expect(html).toContain('PDF');
    expect(html).toContain('500 KB');
    expect(html).toContain('4 Seiten');
    // Download-Aktion (id vorhanden → Download-Button gerendert).
    expect(html).toContain('Download angebot.pdf');
    expect(html).not.toContain('<surface:document>');
    expect(html).toContain('Bitte prüfen');
  });
});

describe('sent user bubble · reiner Text (Regression-Schutz)', () => {
  it('ohne Surface → KEINE Karte, Gate greift nicht (raw-Pfad)', () => {
    const parsed = parseHistoryItem({
      id: 'u1',
      role: 'user',
      content: 'nur eine normale Nachricht',
      ts: new Date().toISOString(),
    });
    expect(parsed.surfaces.length).toBe(0);
  });
});

describe('sent user bubble · mehrere Anhänge', () => {
  it('Bild + Doc gemischt → beide Karten + Caption', () => {
    const content = buildBubbleContent(
      [imageAttachment(), docAttachment()],
      'beide bitte ansehen',
    );
    const html = renderUserBubble(content);
    expect(html).toContain('<img'); // Bild
    expect(html).toContain('angebot.pdf'); // Doc
    expect(html).toContain('beide bitte ansehen');
    expect(html).not.toContain('<surface:document>');
  });
});
