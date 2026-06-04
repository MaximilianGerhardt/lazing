/**
 * Tests für QuickChoice-Behavior-Switch · 2026-05-29 (Phase 1 Track AB · Befund A).
 *
 * BUG (verbatim Handoff §7): „QuickChoice-Klick ruft `reply(o.label)` auf.
 * Gleichzeitig wird `window.dispatchEvent(new CustomEvent('lazyos:quickchoice',
 * ...))` ausgelöst. ChatShell hört auf `lazyos:quickchoice`. Bei Flow-Style-
 * Sessions repostet ChatShell an `/api/flow/compose-and-run` mit styleChoices.
 * → Ein einziger Klick kann zwei Aktionen auslösen:
 *   1. gewünschte strukturierte Flow-Fortsetzung.
 *   2. zusätzliche normale Chat-Nachricht mit nur dem Button-Label.
 *  Das kann Kontext und Routing zerstören."
 *
 * FIX: Payload-Feld `behavior?: 'reply-and-event' | 'event-only'`.
 *   - Default (`reply-and-event`) → bisheriges Verhalten (BACKWARD-COMPAT).
 *   - `event-only` → NUR dispatchEvent, KEIN reply(label).
 *
 * Akzeptanz (verbatim): „Klick auf Flow-Style-Quickchoice erzeugt genau einen
 * Request an /api/flow/compose-and-run. Der Klick erzeugt keinen zusätzlichen
 * /api/chat/stream."
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/quickchoice-behavior.test.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

interface Harness {
  root: Root;
  container: HTMLElement;
  reply: ReturnType<typeof vi.fn>;
  events: string[];
  unmount: () => void;
}

function mount(payload: Record<string, unknown>): Harness {
  const reply = vi.fn();
  const events: string[] = [];
  const onEvt = (ev: Event) => {
    const id = (ev as CustomEvent<{ id?: string }>).detail?.id;
    if (typeof id === 'string') events.push(id);
  };
  window.addEventListener('lazyos:quickchoice', onEvt as EventListener);

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={reply}
        pushAssistant={() => undefined}
      >
        {/* Surface-Renderer liefert das ReactNode für die QuickChoice-Card. */}
        {renderSurface('prompt', payload)}
      </SurfaceActionProvider>,
    );
  });
  return {
    root,
    container,
    reply,
    events,
    unmount: () => {
      window.removeEventListener('lazyos:quickchoice', onEvt as EventListener);
      act(() => root.unmount());
      container.remove();
    },
  };
}

function clickFirstButton(c: HTMLElement) {
  const btn = c.querySelector('button');
  if (!btn) throw new Error('no button found in QuickChoice');
  act(() => {
    btn.click();
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('QuickChoice Behavior-Switch · Befund A (Doppelrouting-Fix)', () => {
  it('Default-Behavior (kein `behavior`-Feld) → reply(label) UND lazyos:quickchoice (Backward-Compat)', () => {
    const h = mount({
      variant: 'quickchoice',
      options: [
        { id: 'opt-a', label: 'Option A', primary: true },
        { id: 'opt-b', label: 'Option B' },
      ],
    });
    try {
      clickFirstButton(h.container);
      // Beide Aktionen feuern — exakt das alte Verhalten.
      expect(h.reply).toHaveBeenCalledTimes(1);
      expect(h.reply).toHaveBeenCalledWith('Option A');
      expect(h.events).toEqual(['opt-a']);
    } finally {
      h.unmount();
    }
  });

  it('behavior:"reply-and-event" → reply(label) UND lazyos:quickchoice (explizit gleich Default)', () => {
    const h = mount({
      variant: 'quickchoice',
      behavior: 'reply-and-event',
      options: [
        { id: 'opt-x', label: 'X' },
        { id: 'opt-y', label: 'Y' },
      ],
    });
    try {
      clickFirstButton(h.container);
      expect(h.reply).toHaveBeenCalledTimes(1);
      expect(h.reply).toHaveBeenCalledWith('X');
      expect(h.events).toEqual(['opt-x']);
    } finally {
      h.unmount();
    }
  });

  it('behavior:"event-only" → NUR lazyos:quickchoice, KEIN reply (Befund-A-Fix)', () => {
    const h = mount({
      variant: 'quickchoice',
      behavior: 'event-only',
      options: [
        { id: 'higgsfield', label: 'Higgsfield manuell', primary: true },
        { id: 'stockfootage', label: 'Stockfootage' },
      ],
    });
    try {
      clickFirstButton(h.container);
      // KRITISCH: reply darf NICHT gerufen werden (sonst doppel-Request).
      expect(h.reply).not.toHaveBeenCalled();
      // Das Window-Event MUSS aber feuern (sonst kein ChatShell-Listener).
      expect(h.events).toEqual(['higgsfield']);
    } finally {
      h.unmount();
    }
  });

  it('behavior:"unbekannt" → fällt auf Default zurück (defensiv, Backward-Compat)', () => {
    const h = mount({
      variant: 'quickchoice',
      behavior: 'irgendwas-das-es-nicht-gibt',
      options: [
        { id: 'a', label: 'Default-Fallback' },
        { id: 'b', label: 'B' },
      ],
    });
    try {
      clickFirstButton(h.container);
      // Defensiv: unbekannte Werte → Default-Verhalten (beide Aktionen).
      expect(h.reply).toHaveBeenCalledTimes(1);
      expect(h.reply).toHaveBeenCalledWith('Default-Fallback');
      expect(h.events).toEqual(['a']);
    } finally {
      h.unmount();
    }
  });

  it('event-only + mehrere Klicks → jeder Klick feuert nur Event (kein reply-Leak)', () => {
    const h = mount({
      variant: 'quickchoice',
      behavior: 'event-only',
      options: [
        { id: 'one', label: 'Eins', primary: true },
        { id: 'two', label: 'Zwei' },
      ],
    });
    try {
      // ZWEI Klicks (in echter App nicht möglich, aber Test prüft Robustheit).
      const btns = h.container.querySelectorAll('button');
      act(() => {
        (btns[0] as HTMLButtonElement).click();
        (btns[1] as HTMLButtonElement).click();
      });
      expect(h.reply).not.toHaveBeenCalled();
      expect(h.events).toEqual(['one', 'two']);
    } finally {
      h.unmount();
    }
  });
});
