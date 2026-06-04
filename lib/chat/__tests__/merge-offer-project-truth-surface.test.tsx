/**
 * A4 + §7.2 + §7.3 + R7 (2026-05-29, Opus 4.8) — Surface-Tests für die
 * langlebigen Surfaces + den klickbaren Merge-Offer.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/chat/__tests__/merge-offer-project-truth-surface.test.tsx
 *
 * Coverage:
 *   (a) renderMergeOffer rendert Datei-Liste + Merge-Button mit korrektem
 *       endpoint/onClick → POST /api/workstreams/<id>/merge-run; preview-Klick
 *       POSTet {preview:true}; Erfolg → resolved (data-state=merged).
 *   (b) project-truth rendert Decisions/Beliefs/Open-Unknowns; collapsible
 *       (Widersprüche erst nach Klick auf „Mehr Details ausklappen").
 *   (c) decision-brief-Variante rendert Optionen + Quelle/Confidence/Konsequenz
 *       + event-only-Verhalten (kein reply() im Default-Modus).
 *   (d) surface-parser akzeptiert die neuen kinds merge-offer + project-truth.
 *   (e) SECURITY: kein Secret-artiges Muster im DOM/Request-Body.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';
import {
  collectParsedChunks,
  stringToAsyncIterable,
  SURFACE_KINDS,
} from '../surface-parser';
import { SURFACE_LIBRARY } from '../../surfaces/registry';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(node: ReturnType<typeof renderSurface>, replySpy?: (t: string) => void): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={replySpy ?? (() => undefined)}
        pushAssistant={() => undefined}
      >
        {node}
      </SurfaceActionProvider>,
    );
  });
  return {
    root,
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function q<T extends HTMLElement = HTMLElement>(c: HTMLElement, sel: string): T | null {
  return c.querySelector<T>(sel);
}
function qa<T extends HTMLElement = HTMLElement>(c: HTMLElement, sel: string): T[] {
  return Array.from(c.querySelectorAll<T>(sel));
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ===========================================================================
// (a) merge-offer
// ===========================================================================

describe('merge-offer surface', () => {
  const WS = '01J0000000000000000000000A';

  it('rendert Datei-Liste + 3 Buttons + korrekten merge-Endpoint', () => {
    const h = mount(
      renderSurface('merge-offer', {
        workstreamId: WS,
        runBranch: 'lazing/run/prun-abc',
        fileCount: 2,
        files: ['app/page.tsx', 'lib/foo.ts'],
        workstreamName: 'example-website',
      }),
    );
    try {
      const card = q(h.container, '[data-test="surface-merge-offer"]');
      expect(card).not.toBeNull();
      const text = h.container.textContent ?? '';
      expect(text).toContain('Build fertig');
      expect(text).toContain('2 Dateien');
      // Datei-Liste.
      const files = qa(h.container, '[data-test="merge-offer-file"]');
      expect(files.map((f) => f.textContent)).toEqual(['app/page.tsx', 'lib/foo.ts']);
      // Run-Branch.
      expect(q(h.container, '[data-test="merge-offer-branch"]')?.textContent).toBe(
        'lazing/run/prun-abc',
      );
      // 3 Buttons.
      const merge = q<HTMLButtonElement>(h.container, '[data-test="merge-offer-merge-btn"]');
      expect(merge).not.toBeNull();
      expect(merge?.getAttribute('data-endpoint')).toBe(
        `/api/workstreams/${WS}/merge-run`,
      );
      expect(q(h.container, '[data-test="merge-offer-diff-btn"]')).not.toBeNull();
      expect(q(h.container, '[data-test="merge-offer-discard-btn"]')).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('Touch-Targets ≥44px auf allen Buttons', () => {
    const h = mount(
      renderSurface('merge-offer', { workstreamId: WS, files: ['a.ts'] }),
    );
    try {
      for (const sel of [
        '[data-test="merge-offer-merge-btn"]',
        '[data-test="merge-offer-diff-btn"]',
        '[data-test="merge-offer-discard-btn"]',
      ]) {
        const btn = q<HTMLButtonElement>(h.container, sel);
        expect(btn).not.toBeNull();
        expect(btn!.style.minHeight).toBe('44px');
      }
    } finally {
      h.unmount();
    }
  });

  it('„In Live mergen" POSTet {} an /merge-run und wechselt nach resolved (merged)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, merged: true, sha: 'abc1234567', files: ['a.ts'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const h = mount(renderSurface('merge-offer', { workstreamId: WS, files: ['a.ts'] }));
    try {
      const btn = q<HTMLButtonElement>(h.container, '[data-test="merge-offer-merge-btn"]');
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`/api/workstreams/${WS}/merge-run`);
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('same-origin');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toEqual({});

      const card = q(h.container, '[data-test="surface-merge-offer"]');
      expect(card?.getAttribute('data-state')).toBe('merged');
      expect(h.container.textContent ?? '').toContain('In Live gemergt');
    } finally {
      h.unmount();
    }
  });

  it('„Diff ansehen" POSTet {preview:true} (read-only, kein Merge)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: true, preview: true, files: ['a.ts', 'b.ts', 'c.ts'] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const h = mount(renderSurface('merge-offer', { workstreamId: WS, files: ['a.ts'] }));
    try {
      const btn = q<HTMLButtonElement>(h.container, '[data-test="merge-offer-diff-btn"]');
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`/api/workstreams/${WS}/merge-run`);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toEqual({ preview: true });
      // Preview-Datei-Liste vom Server übernommen.
      const files = qa(h.container, '[data-test="merge-offer-file"]');
      expect(files.length).toBe(3);
      // Kein resolved-State (read-only).
      expect(
        q(h.container, '[data-test="surface-merge-offer"]')?.getAttribute('data-state'),
      ).not.toBe('merged');
    } finally {
      h.unmount();
    }
  });

  it('„Verwerfen" ist rein lokal (kein fetch) und wechselt nach discarded', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const h = mount(renderSurface('merge-offer', { workstreamId: WS, files: ['a.ts'] }));
    try {
      const btn = q<HTMLButtonElement>(h.container, '[data-test="merge-offer-discard-btn"]');
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(
        q(h.container, '[data-test="surface-merge-offer"]')?.getAttribute('data-state'),
      ).toBe('discarded');
    } finally {
      h.unmount();
    }
  });

  it('409-Konflikt → data-state=conflict + Hinweis, Live unverändert', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, merged: false, conflict: 'Merge-Konflikt in a.ts' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const h = mount(renderSurface('merge-offer', { workstreamId: WS, files: ['a.ts'] }));
    try {
      const btn = q<HTMLButtonElement>(h.container, '[data-test="merge-offer-merge-btn"]');
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        q(h.container, '[data-test="surface-merge-offer"]')?.getAttribute('data-state'),
      ).toBe('conflict');
      expect(q(h.container, '[data-test="merge-offer-error"]')?.textContent).toContain(
        'Merge-Konflikt',
      );
    } finally {
      h.unmount();
    }
  });

  it('fehlende workstreamId → null (kein Render)', () => {
    const h = mount(renderSurface('merge-offer', { files: ['a.ts'] }));
    try {
      expect(q(h.container, '[data-test="surface-merge-offer"]')).toBeNull();
    } finally {
      h.unmount();
    }
  });
});

// ===========================================================================
// (b) project-truth
// ===========================================================================

describe('project-truth surface', () => {
  it('rendert Vision + Decisions + Beliefs + Open-Unknowns', () => {
    const h = mount(
      renderSurface('project-truth', {
        workspaceId: 'ws-1',
        vision: 'lazing keeps AI work steerable.',
        decisions: [{ text: 'Substrat = workstreams erweitern' }],
        beliefs: [{ text: 'N7: lexical RAG zuerst', confidence: 0.8 }],
        openUnknowns: ['Branch-Tree-Navigation Tier 2?'],
        contradictions: [{ text: 'Doc A vs. Doc B widersprechen sich' }],
      }),
    );
    try {
      const card = q(h.container, '[data-test="surface-project-truth"]');
      expect(card).not.toBeNull();
      expect(q(h.container, '[data-test="project-truth-vision"]')?.textContent).toContain(
        'steerable',
      );
      expect(
        qa(h.container, '[data-test="project-truth-decisions-item"]').length,
      ).toBe(1);
      const beliefItem = q(h.container, '[data-test="project-truth-beliefs-item"]');
      expect(beliefItem?.textContent).toContain('lexical RAG');
      expect(beliefItem?.textContent).toContain('80%'); // confidence formatted
      expect(
        qa(h.container, '[data-test="project-truth-open-unknowns-item"]').length,
      ).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('ist collapsible: Widersprüche erst nach Toggle sichtbar', async () => {
    const h = mount(
      renderSurface('project-truth', {
        vision: 'V',
        contradictions: [{ text: 'Geheim-Widerspruch' }],
      }),
    );
    try {
      // Default: collapsed → Widersprüche-Section NICHT im DOM.
      expect(
        q(h.container, '[data-test="surface-project-truth"]')?.getAttribute('data-expanded'),
      ).toBe('false');
      expect(q(h.container, '[data-test="project-truth-contradictions"]')).toBeNull();

      const toggle = q<HTMLButtonElement>(h.container, '[data-test="project-truth-toggle"]');
      expect(toggle).not.toBeNull();
      expect(toggle!.style.minHeight).toBe('44px');
      await act(async () => {
        toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(
        q(h.container, '[data-test="surface-project-truth"]')?.getAttribute('data-expanded'),
      ).toBe('true');
      expect(
        q(h.container, '[data-test="project-truth-contradictions"]')?.textContent,
      ).toContain('Geheim-Widerspruch');
    } finally {
      h.unmount();
    }
  });

  it('akzeptiert String-Arrays für Decisions/Beliefs', () => {
    const h = mount(
      renderSurface('project-truth', {
        decisions: ['D1', 'D2'],
        beliefs: ['B1'],
      }),
    );
    try {
      expect(qa(h.container, '[data-test="project-truth-decisions-item"]').length).toBe(2);
      expect(qa(h.container, '[data-test="project-truth-beliefs-item"]').length).toBe(1);
    } finally {
      h.unmount();
    }
  });

  it('NICHT interaktiv im Lese-Sinn: keine Schreib-Buttons (nur Toggle)', () => {
    const h = mount(
      renderSurface('project-truth', { decisions: ['D1'] }),
    );
    try {
      const buttons = qa<HTMLButtonElement>(h.container, 'button');
      // Höchstens der collapse-Toggle.
      for (const b of buttons) {
        expect(b.getAttribute('data-test')).toBe('project-truth-toggle');
      }
    } finally {
      h.unmount();
    }
  });

  it('komplett leerer Anker → null', () => {
    const h = mount(renderSurface('project-truth', {}));
    try {
      expect(q(h.container, '[data-test="surface-project-truth"]')).toBeNull();
    } finally {
      h.unmount();
    }
  });
});

// ===========================================================================
// (c) decision-brief (prompt variant)
// ===========================================================================

describe('prompt variant=decision-brief', () => {
  it('rendert Headline + Quelle + Confidence + Konsequenz + Optionen', () => {
    const h = mount(
      renderSurface('prompt', {
        variant: 'decision-brief',
        headline: 'Wir gehen mit Higgsfield für Motion',
        source: 'PA-Chat 2026-05-27',
        sourceBy: 'Owner',
        confidence: 0.75,
        consequence: 'HeyGen wird nur für Avatar genutzt',
        options: [
          { id: 'go', label: 'Bestätigen', recommended: true },
          { id: 'no', label: 'Ablehnen' },
        ],
      }),
    );
    try {
      const card = q(h.container, '[data-test="surface-decision-brief"]');
      expect(card).not.toBeNull();
      expect(h.container.textContent ?? '').toContain('Higgsfield für Motion');
      expect(q(h.container, '[data-test="decision-brief-source"]')?.textContent).toContain(
        'PA-Chat',
      );
      expect(q(h.container, '[data-test="decision-brief-by"]')?.textContent).toContain('Owner');
      expect(
        q(h.container, '[data-test="decision-brief-confidence"]')?.textContent,
      ).toContain('75%');
      expect(
        q(h.container, '[data-test="decision-brief-consequence"]')?.textContent,
      ).toContain('Avatar');
      expect(qa(h.container, '[data-test="decision-brief-option"]').length).toBe(2);
    } finally {
      h.unmount();
    }
  });

  it('event-only by default: Klick triggert KEIN reply()', async () => {
    const replySpy = vi.fn();
    const h = mount(
      renderSurface('prompt', {
        variant: 'decision-brief',
        headline: 'E?',
        options: [{ id: 'a', label: 'A', recommended: true }],
      }),
      replySpy,
    );
    try {
      const card = q(h.container, '[data-test="surface-decision-brief"]');
      expect(card?.getAttribute('data-behavior')).toBe('event-only');
      const opt = q<HTMLButtonElement>(h.container, '[data-test="decision-brief-option"]');
      await act(async () => {
        opt!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      // event-only → kein Doppel-Routing über reply().
      expect(replySpy).not.toHaveBeenCalled();
      expect(card?.getAttribute('data-chosen')).toBe('a');
    } finally {
      h.unmount();
    }
  });

  it('behavior=reply-and-event: Klick triggert genau ein reply()', async () => {
    const replySpy = vi.fn();
    const h = mount(
      renderSurface('prompt', {
        variant: 'decision-brief',
        headline: 'E2?',
        behavior: 'reply-and-event',
        options: [{ id: 'yes', label: 'Ja' }],
      }),
      replySpy,
    );
    try {
      const card = q(h.container, '[data-test="surface-decision-brief"]');
      expect(card?.getAttribute('data-behavior')).toBe('reply-and-event');
      const opt = q<HTMLButtonElement>(h.container, '[data-test="decision-brief-option"]');
      await act(async () => {
        opt!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
    } finally {
      h.unmount();
    }
  });

  it('ohne options → Default Bestätigen/Ablehnen', () => {
    const h = mount(
      renderSurface('prompt', { variant: 'decision-brief', headline: 'D?' }),
    );
    try {
      const opts = qa(h.container, '[data-test="decision-brief-option"]');
      expect(opts.length).toBe(2);
      expect((h.container.textContent ?? '')).toContain('Bestätigen');
      expect((h.container.textContent ?? '')).toContain('Ablehnen');
    } finally {
      h.unmount();
    }
  });
});

// ===========================================================================
// (d) surface-parser akzeptiert die neuen kinds
// ===========================================================================

describe('surface-parser akzeptiert merge-offer + project-truth', () => {
  it('merge-offer + project-truth sind in SURFACE_KINDS', () => {
    expect(SURFACE_KINDS).toContain('merge-offer');
    expect(SURFACE_KINDS).toContain('project-truth');
  });

  it('<surface:merge-offer> wird als surface-chunk geparst (nicht als text)', async () => {
    const json = JSON.stringify({ workstreamId: 'ws-1', files: ['a.ts'] });
    const chunks = await collectParsedChunks(
      stringToAsyncIterable(`<surface:merge-offer>${json}</surface:merge-offer>`),
    );
    const surf = chunks.find((c) => c.type === 'surface');
    expect(surf).toBeTruthy();
    expect(surf && surf.type === 'surface' && surf.kind).toBe('merge-offer');
  });

  it('<surface:project-truth> wird als surface-chunk geparst', async () => {
    const json = JSON.stringify({ decisions: ['D1'] });
    const chunks = await collectParsedChunks(
      stringToAsyncIterable(`<surface:project-truth>${json}</surface:project-truth>`),
    );
    const surf = chunks.find((c) => c.type === 'surface');
    expect(surf && surf.type === 'surface' && surf.kind).toBe('project-truth');
  });

  it('Registry kennt beide kinds inkl. R7-lifecycle', () => {
    expect(SURFACE_LIBRARY['merge-offer'].lifecycle).toContain('resolved');
    expect(SURFACE_LIBRARY['project-truth'].lifecycle).toContain('superseded');
  });
});

// ===========================================================================
// (e) SECURITY — kein Secret-Muster
// ===========================================================================

describe('SECURITY: keine Secret-Muster', () => {
  it('merge-offer DOM enthält keine Secret-Muster', () => {
    const h = mount(
      renderSurface('merge-offer', {
        workstreamId: 'ws-1',
        files: ['app/page.tsx'],
      }),
    );
    try {
      const text = h.container.textContent ?? '';
      expect(text).not.toMatch(/sk_live_/);
      expect(text).not.toMatch(/Bearer [A-Za-z0-9]{20,}/);
    } finally {
      h.unmount();
    }
  });
});
