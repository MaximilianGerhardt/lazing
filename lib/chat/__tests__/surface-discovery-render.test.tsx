/**
 * Slice C · C4 — Discovery-Surface Render-Tests (2026-05-29).
 *
 * Verifiziert, dass:
 *   1) collapsed-default Header korrekt rendert (running → „Discovery läuft …",
 *      done mit Hosts → „Discovery · host1 · host2").
 *   2) URLs mit status='ok' den Titel + URL rendern.
 *   3) URLs mit status='failed'/'timeout' den „nicht erreichbar"-Hinweis tragen.
 *   4) pendingDocRequests die „Dokumente anfordern"-Liste rendern.
 *   5) Leere Payload (keine URLs, keine Docs) den Leer-Hinweis zeigt.
 *
 * Rendering im SSR-Pfad: <details>/<summary> → vollständiges Markup ist
 * sichtbar (auch collapsed); wir testen die enthaltenen Strings, nicht die
 * visuelle Collapse-Folding.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { renderSurface } from '../SurfaceRenderer';

function html(payload: unknown): string {
  return renderToStaticMarkup(
    createElement('div', null, renderSurface('discovery', payload)),
  );
}

describe('renderSurface(discovery) — Header', () => {
  it('status=running ohne URLs ⇒ „Discovery läuft …"', () => {
    const h = html({ workspaceId: 'ws', workstreamId: 'wf', status: 'running', urls: [] });
    expect(h).toContain('Discovery läuft');
  });

  it('status=done mit Hosts ⇒ „Discovery · example-agency.example · example.com"', () => {
    const h = html({
      workspaceId: 'ws',
      workstreamId: 'wf',
      status: 'done',
      urls: [
        { url: 'https://example-agency.example/cases', status: 'ok', title: 'example-agency' },
        { url: 'https://example.com', status: 'ok' },
      ],
    });
    expect(h).toContain('Discovery · example-agency.example · example.com');
  });

  it('mehr als 3 Hosts ⇒ Header zeigt „+N" Indikator', () => {
    const h = html({
      workspaceId: 'ws', workstreamId: 'wf', status: 'done',
      urls: [
        { url: 'https://a.io', status: 'ok' },
        { url: 'https://b.io', status: 'ok' },
        { url: 'https://c.io', status: 'ok' },
        { url: 'https://d.io', status: 'ok' },
        { url: 'https://e.io', status: 'ok' },
      ],
    });
    expect(h).toMatch(/\+2/);
  });
});

describe('renderSurface(discovery) — URL-Liste', () => {
  it('ok-URL rendert Titel + URL', () => {
    const h = html({
      workspaceId: 'ws', workstreamId: 'wf', status: 'done',
      urls: [{ url: 'https://example-agency.example', status: 'ok', title: 'example-agency', summary: 'AI-Workflows' }],
    });
    expect(h).toContain('example-agency');
    expect(h).toContain('https://example-agency.example');
    expect(h).toContain('AI-Workflows');
  });

  it('failed-URL zeigt „nicht erreichbar (failed)"', () => {
    const h = html({
      workspaceId: 'ws', workstreamId: 'wf', status: 'done',
      urls: [{ url: 'https://dead.example', status: 'failed' }],
    });
    expect(h).toContain('nicht erreichbar (failed)');
  });

  it('timeout-URL zeigt „nicht erreichbar (timeout)"', () => {
    const h = html({
      workspaceId: 'ws', workstreamId: 'wf', status: 'done',
      urls: [{ url: 'https://slow.example', status: 'timeout' }],
    });
    expect(h).toContain('nicht erreichbar (timeout)');
  });
});

describe('renderSurface(discovery) — Doku-Anforderungen', () => {
  it('pendingDocRequests rendert „Dokumente vom Owner anfordern"-Liste', () => {
    const h = html({
      workspaceId: 'ws', workstreamId: 'wf', status: 'done',
      urls: [],
      pendingDocRequests: ['Meisterdokument als PDF'],
    });
    expect(h).toContain('Dokumente vom Owner anfordern');
    expect(h).toContain('Meisterdokument als PDF');
  });
});

describe('renderSurface(discovery) — Empty + invalid', () => {
  it('leere URL-Liste + keine Docs (done) ⇒ Leer-Hinweis', () => {
    const h = html({ workspaceId: 'ws', workstreamId: 'wf', status: 'done', urls: [] });
    expect(h).toContain('Keine Quellen oder Dokumente im Prompt erkannt');
  });

  it('invalid Payload (no object) ⇒ null (kein Throw)', () => {
    expect(html(null)).toContain('<div></div>');
    expect(html('not-an-object')).toContain('<div></div>');
  });
});
