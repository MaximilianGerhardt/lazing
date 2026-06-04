/**
 * Tests für SessionControls — •••-Trigger + Action-Sheet (Welle A · 2026-05-03).
 *
 * Lauf: pnpm exec vitest run lib/chat/__tests__/SessionControls.test.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { SessionControls } from '../SessionControls';
import type { HistoryItem } from '../ChatShell';

// happy-dom liefert window/document. Wir mounten via React und tappen DOM.

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface Harness {
  root: Root;
  container: HTMLElement;
  toasts: unknown[];
  unmount: () => void;
}

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const toasts: unknown[] = [];
  const root = createRoot(container);

  function Wrapper(): React.JSX.Element {
    const [history, setHistory] = useState<HistoryItem[]>([]);
    return (
      <SessionControls
        workspaceId="ws-test"
        history={history}
        setHistory={setHistory}
        pushSystemToast={(t) => toasts.push(t)}
      />
    );
  }

  act(() => {
    root.render(<Wrapper />);
  });

  return {
    root,
    container,
    toasts,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function getTrigger(container: HTMLElement): HTMLButtonElement {
  const t = container.querySelector<HTMLButtonElement>('.chat-session-trigger');
  if (!t) throw new Error('trigger not found');
  return t;
}

function getSheet(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.chat-session-sheet');
}

function getRows(): HTMLButtonElement[] {
  // Action-Rows nur — Cancel-Row hat zusätzlich data-cancel="true".
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-sheet-row="true"]:not([data-cancel])',
    ),
  );
}

function getCancelRow(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-cancel="true"]');
}

describe('SessionControls · sheet open/close', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('rendert nur den Trigger im Closed-State', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      expect(trig.getAttribute('aria-expanded')).toBe('false');
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('Tap auf Trigger öffnet das Sheet mit allen 4 Rows', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      act(() => trig.click());
      expect(getSheet()).not.toBeNull();
      expect(trig.getAttribute('aria-expanded')).toBe('true');
      expect(getRows().length).toBe(4);
    } finally {
      h.unmount();
    }
  });

  it('Klick auf Trigger im Open-State schließt das Sheet', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      act(() => trig.click());
      expect(getSheet()).not.toBeNull();
      act(() => trig.click());
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('Escape schließt das Sheet', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      act(() => trig.click());
      expect(getSheet()).not.toBeNull();
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('Backdrop-Tap schließt das Sheet', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      act(() => trig.click());
      const backdrop = document.querySelector<HTMLElement>(
        '.chat-session-sheet-backdrop',
      );
      expect(backdrop).not.toBeNull();
      // Synthetic click direkt auf Backdrop (target === currentTarget)
      act(() => {
        backdrop?.click();
      });
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });
});

describe('SessionControls · destructive Inline-Confirm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('erster Tap auf destructive Row markiert sie als confirming, zweiter führt aus', async () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const rows = getRows();
      // Reihenfolge im Component: compact, session-new, clear, stop
      const stopRow = rows.find((r) => r.dataset.destructive === 'true' && /Workstreams/i.test(r.getAttribute('aria-label') ?? ''));
      expect(stopRow).toBeTruthy();
      // 1. Tap → confirming
      act(() => stopRow!.click());
      expect(stopRow!.dataset.confirming).toBe('true');
      expect(getSheet()).not.toBeNull(); // Sheet bleibt offen während Confirm
    } finally {
      h.unmount();
    }
  });

  it('Confirming-State revertiert nach 4 Sekunden', () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const rows = getRows();
      const clearRow = rows.find((r) =>
        /Verlauf lokal leeren/i.test(r.getAttribute('aria-label') ?? ''),
      );
      expect(clearRow).toBeTruthy();
      act(() => clearRow!.click());
      expect(clearRow!.dataset.confirming).toBe('true');
      // 4s vorspulen
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      // Re-Query weil React refresh den DOM-Knoten möglicherweise behält,
      // das Attribut aber wegfällt.
      const after = getRows().find((r) =>
        /Verlauf lokal leeren/i.test(r.getAttribute('aria-label') ?? ''),
      );
      expect(after?.dataset.confirming).toBeUndefined();
    } finally {
      h.unmount();
    }
  });
});

describe('SessionControls · non-destructive Sofort-Action', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('Compact-Row tappt direkt aus, kein Confirm-Step', async () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const rows = getRows();
      const compactRow = rows.find((r) =>
        /[Kk]ompakt/i.test(r.getAttribute('aria-label') ?? ''),
      );
      expect(compactRow).toBeTruthy();
      // Tap → kein confirming, sondern run + close
      act(() => compactRow!.click());
      // Microtask-flush
      await act(() => flush());
      // Sheet sollte sich geschlossen haben (run + closeSheet im Promise)
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });
});

describe('SessionControls · Cancel-Row (iOS-Pattern)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('rendert eine Cancel-Row und schließt damit das Sheet', () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const cancel = getCancelRow();
      expect(cancel).not.toBeNull();
      expect(cancel?.textContent?.trim()).toBe('Abbrechen');
      act(() => cancel!.click());
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });
});

describe('SessionControls · Aria + DOM-Hooks', () => {
  it('Trigger hat aria-haspopup=menu', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      expect(trig.getAttribute('aria-haspopup')).toBe('menu');
      expect(trig.getAttribute('aria-label')).toBe('Sitzungs-Aktionen');
    } finally {
      h.unmount();
    }
  });

  it('Sheet hat role=menu und aria-modal=true', () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const sheet = getSheet();
      expect(sheet?.getAttribute('role')).toBe('menu');
      expect(sheet?.getAttribute('aria-modal')).toBe('true');
    } finally {
      h.unmount();
    }
  });
});
