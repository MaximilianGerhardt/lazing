/**
 * SurfaceHelperAffordance — Manifestation-Layer-Helper (Owner-Wunsch 2026-05-30)
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/chat/__tests__/surface-helper-affordance.test.tsx
 *
 * Coverage:
 *   (a) Affordanz erscheint, wenn renderSurface null liefert (render-null),
 *       bei Parse-Fehler (parse-error) und bei unbekanntem Kind (unknown-kind)
 *       — über renderSurfaceOrHelper + den vollen renderChatText-Pfad.
 *   (b) „Korrigieren" erscheint NICHT bei unknown-kind, aber bei
 *       render-null/parse-error.
 *   (c) Klick auf „✨ Surface generieren" ruft den registrierten Regen-Handler
 *       mit korrektem SurfaceRegenRequest; ohne Handler fällt es fail-soft auf
 *       reply() zurück.
 *   (d) Affordanz erscheint NICHT bei einem gültigen Surface (Toast).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

import { renderSurfaceOrHelper } from '../SurfaceRenderer';
import { renderChatText } from '../surface-text-render';
import { SurfaceActionProvider } from '../SurfaceActionContext';
import {
  registerSurfaceRegenHandler,
  hasSurfaceRegenHandler,
  type SurfaceRegenRequest,
} from '../SurfaceHelperAffordance';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(node: ReactNode, replySpy?: (t: string) => void): Harness {
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

function q<T extends HTMLElement = HTMLElement>(
  c: HTMLElement,
  sel: string,
): T | null {
  return c.querySelector<T>(sel);
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SurfaceHelperAffordance — erscheint am Nicht-Render-Punkt', () => {
  it('(a) render-null: leeres toast-Payload → Affordanz + generate + correct', () => {
    // renderToast gibt bei leerem title+body null zurück → render-null.
    const h = mount(renderSurfaceOrHelper('toast', {}, '<surface:toast>{}</surface:toast>'));
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-surface-reason')).toBe('render-null');
      expect(q(h.container, '[data-test="surface-helper-generate"]')).not.toBeNull();
      expect(q(h.container, '[data-test="surface-helper-correct"]')).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('(a) parse-error: data=null → Affordanz mit reason=parse-error', () => {
    const h = mount(
      renderSurfaceOrHelper('toast', null, '<surface:toast>{bad json}</surface:toast>'),
    );
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card?.getAttribute('data-surface-reason')).toBe('parse-error');
      expect(q(h.container, '[data-test="surface-helper-correct"]')).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('(b) unknown-kind: kein „Korrigieren", nur „generieren"', () => {
    const h = mount(
      renderSurfaceOrHelper(
        'totally-made-up',
        { foo: 1 },
        '<surface:totally-made-up>{"foo":1}</surface:totally-made-up>',
      ),
    );
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card?.getAttribute('data-surface-reason')).toBe('unknown-kind');
      expect(q(h.container, '[data-test="surface-helper-generate"]')).not.toBeNull();
      // Korrigieren ist bei unknown-kind sinnlos → fehlt.
      expect(q(h.container, '[data-test="surface-helper-correct"]')).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('(d) gültiges Surface → KEINE Affordanz', () => {
    const h = mount(
      renderSurfaceOrHelper(
        'toast',
        { variant: 'ok', title: 'Fertig', body: 'Alles gut' },
        '<surface:toast>{"variant":"ok","title":"Fertig","body":"Alles gut"}</surface:toast>',
      ),
    );
    try {
      expect(q(h.container, '[data-test="surface-helper-affordance"]')).toBeNull();
    } finally {
      h.unmount();
    }
  });
});

describe('Trigger-Hook (Agent-I-Vertrag)', () => {
  it('(c) Klick „generieren" ruft registrierten Handler mit korrektem Request', () => {
    const seen: SurfaceRegenRequest[] = [];
    const unregister = registerSurfaceRegenHandler((req) => {
      seen.push(req);
    });
    expect(hasSurfaceRegenHandler()).toBe(true);
    const raw = '<surface:toast>{}</surface:toast>';
    const h = mount(renderSurfaceOrHelper('toast', {}, raw));
    try {
      const btn = q<HTMLButtonElement>(
        h.container,
        '[data-test="surface-helper-generate"]',
      );
      act(() => {
        btn?.click();
      });
      expect(seen.length).toBe(1);
      expect(seen[0]).toMatchObject({
        reason: 'render-null',
        kind: 'toast',
        raw,
        intent: 'generate',
      });
    } finally {
      h.unmount();
      unregister();
      expect(hasSurfaceRegenHandler()).toBe(false);
    }
  });

  it('(c) ohne Handler fällt „generieren" fail-soft auf reply() zurück', () => {
    const replies: string[] = [];
    const h = mount(
      renderSurfaceOrHelper('toast', {}, '<surface:toast>{}</surface:toast>'),
      (t) => replies.push(t),
    );
    try {
      expect(hasSurfaceRegenHandler()).toBe(false);
      const btn = q<HTMLButtonElement>(
        h.container,
        '[data-test="surface-helper-generate"]',
      );
      act(() => {
        btn?.click();
      });
      expect(replies.length).toBe(1);
      expect(replies[0]).toContain('generiere');
      expect(replies[0]).toContain('toast');
    } finally {
      h.unmount();
    }
  });
});

describe('Integration über renderChatText (voller Render-Pfad)', () => {
  it('unknown-kind-Tag im Chat-Text → Affordanz statt nacktem Tag', () => {
    // Hinweis: renderChatText nutzt SURFACE_RE (a-z- only). Ein unbekannter
    // aber syntaktisch passender Kind („mystery") matcht den Tag → isKind=false
    // → renderSurfaceOrHelper(unknown-kind).
    const text = 'Vorher\n<surface:mystery>{"x":1}</surface:mystery>\nNachher';
    const nodes = renderChatText(text);
    const h = mount(<>{nodes}</>);
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-surface-reason')).toBe('unknown-kind');
    } finally {
      h.unmount();
    }
  });

  it('parse-error im Chat-Text → Affordanz mit reason=parse-error', () => {
    const text = '<surface:toast>{nicht valides json}</surface:toast>';
    const nodes = renderChatText(text);
    const h = mount(<>{nodes}</>);
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card?.getAttribute('data-surface-reason')).toBe('parse-error');
    } finally {
      h.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Intentionally-silent kinds (Render-Critic CRITICAL, 2026-05-30).
// ---------------------------------------------------------------------------
// `onboarding-progress` is whitelisted + parses fine, but its renderer arm is
// designed to return null (TODO Wave-3). Empirically it was the dominant real
// source of the critic's "surfaces tip into the fallback card" report — it
// fired the alarming "Diese Ansicht ließ sich nicht aufbauen" card on every
// load of the rich `website` / `example-website` workspaces. It must now render
// NOTHING (no helper card), while a genuinely thin surface still shows it.
describe('Intentionally-silent kinds rendern keine Fallback-Karte', () => {
  it('onboarding-progress (render-null by design) → KEINE Affordanz-Karte', () => {
    const text =
      'Status\n<surface:onboarding-progress>{"workspaceId":"website","status":"running"}</surface:onboarding-progress>\nText danach';
    const nodes = renderChatText(text);
    const h = mount(<>{nodes}</>);
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card).toBeNull();
      // Surrounding text must still render.
      expect(h.container.textContent).toContain('Text danach');
    } finally {
      h.unmount();
    }
  });

  it('ein normaler render-null-Kind (toast ohne title/body) zeigt WEITERHIN die Affordanz', () => {
    // Toast with empty payload → renderToast returns null → real "payload too
    // thin" case → helper SHOULD appear (silent-kind allowlist is tiny + exact).
    const text = '<surface:toast>{}</surface:toast>';
    const nodes = renderChatText(text);
    const h = mount(<>{nodes}</>);
    try {
      const card = q(h.container, '[data-test="surface-helper-affordance"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-surface-reason')).toBe('render-null');
    } finally {
      h.unmount();
    }
  });
});
