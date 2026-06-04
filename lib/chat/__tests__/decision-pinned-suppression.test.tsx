/**
 * F18 (2026-05-30) — in-feed Decision/QuickChoice Suppression + Klick-Hooks.
 *
 * Owner-Direktive F18: „Entscheidung benötigt / Gates IMMER unten über dem Chat
 * angepinnt." Die Decision wird jetzt als blockingGate im ActionDeck unten
 * gepinnt. Damit es KEINE zwei lauten Kopien gibt, stellt sich die in-feed-
 * Karte RUHIG (Referenz/Beleg), sobald GENAU diese Decision gepinnt ist
 * (`PinnedDecisionRegistryProvider`). Provider-frei → laute Karte (Back-Compat).
 *
 * Zusätzlich: die laute Karte trägt die data-test-Hooks
 * (`surface-decision` + `surface-decision-option`[data-option-id]), über die
 * der ActionDeck (executeGateAction) den ECHTEN reply(label)-Button klickt —
 * EIN Submit-Pfad, kein zweites Routing.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/chat/__tests__/decision-pinned-suppression.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  renderSurface,
  PinnedDecisionRegistryProvider,
} from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

interface Harness {
  container: HTMLElement;
  root: Root;
  reply: ReturnType<typeof vi.fn>;
  cleanup: () => void;
}

function mount(
  node: React.ReactNode,
  pinnedHeadline?: string | null,
): Harness {
  const reply = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PinnedDecisionRegistryProvider pinnedHeadline={pinnedHeadline}>
        <SurfaceActionProvider reply={reply} pushAssistant={() => undefined}>
          {node}
        </SurfaceActionProvider>
      </PinnedDecisionRegistryProvider>,
    );
  });
  return {
    container,
    root,
    reply,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const DECISION = {
  kind: 'decision' as const,
  headline: 'Welche Variante mergen?',
  options: [
    { id: 'a', label: 'Variante A' },
    { id: 'b', label: 'Variante B', recommended: true },
    { id: 'c', label: 'Variante C' },
  ],
};

describe('in-feed Decision — Suppression wenn gepinnt (F18)', () => {
  it('NICHT gepinnt (kein Provider-Match) → laute Karte mit Klick-Hooks', () => {
    const h = mount(renderSurface('decision', DECISION), null);
    cleanups.push(h.cleanup);
    // laute Variante.
    expect(
      h.container.querySelector('[data-test="surface-decision"]'),
    ).not.toBeNull();
    // KEINE ruhige Referenz.
    expect(
      h.container.querySelector('[data-test="surface-decision-ref"]'),
    ).toBeNull();
    // pro Option ein Klick-Hook.
    expect(
      h.container.querySelectorAll('[data-test="surface-decision-option"]').length,
    ).toBe(3);
    // die empfohlene Option trägt data-recommended.
    const rec = h.container.querySelector(
      '[data-test="surface-decision-option"][data-recommended="true"]',
    );
    expect(rec?.getAttribute('data-option-id')).toBe('b');
  });

  it('gepinnt (Headline matcht) → ruhige Referenz, KEINE laute Karte', () => {
    const h = mount(
      renderSurface('decision', DECISION),
      'Welche Variante mergen?',
    );
    cleanups.push(h.cleanup);
    expect(
      h.container.querySelector('[data-test="surface-decision-ref"]'),
    ).not.toBeNull();
    // die laute Karte + ihre Optionen sind weg (nur EINE Kopie, unten gepinnt).
    expect(
      h.container.querySelector('[data-test="surface-decision"]'),
    ).toBeNull();
    expect(
      h.container.querySelectorAll('[data-test="surface-decision-option"]').length,
    ).toBe(0);
    // N1: verbatim Headline bleibt im Beleg sichtbar.
    expect(h.container.textContent).toContain('Welche Variante mergen?');
  });

  it('Klick-Hook ruft reply(label) — EIN Submit-Pfad (kein Doppel)', () => {
    const h = mount(renderSurface('decision', DECISION), null);
    cleanups.push(h.cleanup);
    const hook = h.container.querySelector<HTMLButtonElement>(
      '[data-test="surface-decision-option"][data-option-id="b"]',
    );
    act(() => hook!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(h.reply).toHaveBeenCalledTimes(1);
    expect(h.reply).toHaveBeenCalledWith('Variante B'); // verbatim Label.
  });

  it('quickchoice gepinnt (Label-Signatur matcht) → ruhige Referenz', () => {
    const payload = {
      variant: 'quickchoice',
      options: [
        { id: 'ja', label: 'Ja, weiter', primary: true },
        { id: 'nein', label: 'Abbrechen' },
      ],
    };
    const h = mount(
      renderSurface('prompt', payload),
      'Ja, weiter · Abbrechen',
    );
    cleanups.push(h.cleanup);
    expect(
      h.container.querySelector('[data-test="surface-quickchoice-ref"]'),
    ).not.toBeNull();
  });

  it('quickchoice NICHT gepinnt → laute Karte + Hooks (reply-Pfad erhalten)', () => {
    const payload = {
      variant: 'quickchoice',
      options: [
        { id: 'ja', label: 'Ja, weiter', primary: true },
        { id: 'nein', label: 'Abbrechen' },
      ],
    };
    const h = mount(renderSurface('prompt', payload), null);
    cleanups.push(h.cleanup);
    expect(
      h.container.querySelector('[data-test="surface-decision"][data-quickchoice="true"]'),
    ).not.toBeNull();
    const hook = h.container.querySelector<HTMLButtonElement>(
      '[data-test="surface-decision-option"][data-option-id="ja"]',
    );
    act(() => hook!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(h.reply).toHaveBeenCalledWith('Ja, weiter');
  });
});
