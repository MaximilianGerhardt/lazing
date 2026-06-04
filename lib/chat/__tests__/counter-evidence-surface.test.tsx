/**
 * counter-evidence Surface-Render Tests (E4.3, P13, 2026-05-27).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/counter-evidence-surface.test.tsx
 *
 * Cases (Plan §E4.4):
 *   1. Render: Counter-Punkte einzeln sichtbar + Verdict-Pill.
 *   2. Rotes Flag bei unfalsifiable (eigener Banner, role=alert).
 *   3. Kein rotes Flag bei falsifiable; Counter-Count-Hinweis sichtbar.
 *   4. Volltext-Fallback wenn keine `### Counter N`-Header erkennbar.
 *   5. Leere Payload → null (kein Throw).
 *   6. unfalsifiable aus Verdict abgeleitet (auch ohne Bool-Feld).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(data: unknown): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={() => undefined}
      >
        {renderSurface('counter-evidence', data)}
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

const FALSIFIABLE_TEXT = `## Counter-Evidence

### Counter 1: User klickt nie
Wenn Telemetrie <2% Klicks zeigt, ist die These widerlegt.

### Counter 2: Latency-Hit
Wenn p99 > 200ms steigt, bricht die These.

### Counter 3: Sub-Tickets ungenutzt
Wenn 80% nach 7 Tagen offen, Premise widerlegt.

## Verdict
{verdict: "falsifiable"}`;

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('counter-evidence surface', () => {
  it('rendert die Counter-Punkte einzeln + Verdict-Pill', () => {
    const h = mount({
      text: FALSIFIABLE_TEXT,
      verdict: 'falsifiable',
      unfalsifiable: false,
      counterEvidenceCount: 3,
    });
    try {
      const card = h.container.querySelector('[data-test="surface-counter-evidence"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-verdict')).toBe('falsifiable');
      expect(card?.getAttribute('data-unfalsifiable')).toBe('false');

      const points = h.container.querySelectorAll('[data-test="counter-evidence-point"]');
      expect(points).toHaveLength(3);

      const txt = h.container.textContent ?? '';
      expect(txt).toContain('User klickt nie');
      expect(txt).toContain('Latency-Hit');
      expect(txt).toContain('Sub-Tickets ungenutzt');
      expect(txt).toContain("Devil");

      const verdictPill = h.container.querySelector(
        '[data-test="counter-evidence-verdict"]',
      );
      expect(verdictPill?.getAttribute('data-verdict')).toBe('falsifiable');
      expect(verdictPill?.textContent ?? '').toContain('Falsifizierbar');
    } finally {
      h.unmount();
    }
  });

  it('zeigt KEIN rotes Flag bei falsifiable, aber den Count-Hinweis', () => {
    const h = mount({
      text: FALSIFIABLE_TEXT,
      verdict: 'falsifiable',
      counterEvidenceCount: 3,
    });
    try {
      expect(
        h.container.querySelector('[data-test="counter-evidence-red-flag"]'),
      ).toBeNull();
      const count = h.container.querySelector('[data-test="counter-evidence-count"]');
      expect(count?.textContent ?? '').toContain('3 widerlegende');
    } finally {
      h.unmount();
    }
  });

  it('zeigt das ROTE FLAG (role=alert) wenn unfalsifiable=true', () => {
    const h = mount({
      text: 'Die These ist tautologisch.',
      verdict: 'unfalsifiable',
      unfalsifiable: true,
      counterEvidenceCount: 0,
    });
    try {
      const card = h.container.querySelector('[data-test="surface-counter-evidence"]');
      expect(card?.getAttribute('data-unfalsifiable')).toBe('true');

      const flag = h.container.querySelector<HTMLElement>(
        '[data-test="counter-evidence-red-flag"]',
      );
      expect(flag).not.toBeNull();
      expect(flag?.getAttribute('role')).toBe('alert');
      expect(flag?.textContent ?? '').toContain('nicht falsifizierbar');
    } finally {
      h.unmount();
    }
  });

  it('leitet unfalsifiable aus dem Verdict ab, auch ohne Bool-Feld', () => {
    const h = mount({
      text: 'Tautologie.',
      verdict: 'unfalsifiable',
      counterEvidenceCount: 0,
    });
    try {
      const card = h.container.querySelector('[data-test="surface-counter-evidence"]');
      expect(card?.getAttribute('data-unfalsifiable')).toBe('true');
      expect(
        h.container.querySelector('[data-test="counter-evidence-red-flag"]'),
      ).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('fällt auf den Volltext zurück wenn keine Counter-Header erkennbar', () => {
    const h = mount({
      text: 'Reiner Fließtext ohne Counter-Markup, aber relevant.',
      verdict: 'weak-evidence',
      counterEvidenceCount: 1,
    });
    try {
      expect(
        h.container.querySelectorAll('[data-test="counter-evidence-point"]'),
      ).toHaveLength(0);
      const full = h.container.querySelector('[data-test="counter-evidence-fulltext"]');
      expect(full?.textContent ?? '').toContain('Reiner Fließtext');
    } finally {
      h.unmount();
    }
  });

  it('rendert nichts (null) bei komplett leerer Payload (kein Throw)', () => {
    const h = mount({});
    try {
      expect(
        h.container.querySelector('[data-test="surface-counter-evidence"]'),
      ).toBeNull();
    } finally {
      h.unmount();
    }
  });
});
