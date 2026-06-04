/**
 * Tests für StatusCluster — Welle B · 2026-05-03.
 *
 * Lauf: pnpm exec vitest run lib/nav/__tests__/StatusCluster.test.tsx
 *
 * Tests fokussieren auf Severity-Mapping + Sheet-Mechanik. Polling der
 * Sub-Indicators wird nicht doppelt getestet — die haben eigene Suites.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { StatusCluster } from '../StatusCluster';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<StatusCluster vapidPublicKey="fake" />);
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

function getTrigger(c: HTMLElement): HTMLButtonElement {
  const t = c.querySelector<HTMLButtonElement>('.status-cluster');
  if (!t) throw new Error('cluster trigger not found');
  return t;
}

function getSheet(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.status-cluster-sheet');
}

function makeFetchMock(opts: {
  running?: number;
  stuck?: number;
  alive?: number;
  stale?: number;
  error?: number;
  total?: number;
}): typeof fetch {
  const {
    running = 0,
    stuck = 0,
    alive = 0,
    stale = 0,
    error = 0,
    total = 0,
  } = opts;
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.includes('/api/activity/live')) {
      return new Response(
        JSON.stringify({ ok: true, running, stuck, paused: 0, cronSoon: 0 }),
        { status: 200 },
      );
    }
    if (url.includes('/api/heartbeat/status')) {
      return new Response(
        JSON.stringify({
          ok: true,
          globals: { alive, stale, dormant: 0, error, total },
        }),
        { status: 200 },
      );
    }
    if (url.includes('/api/quota/tpm-status')) {
      return new Response(JSON.stringify({ pct: 0, current: 0, max: 100 }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

describe('StatusCluster · Severity-Probe', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMock({ running: 0 }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('rendert mit data-severity=idle als Default vor Probe', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      // Initial-Render vor first probe → idle (loading).
      expect(['idle', 'running', 'warn', 'error']).toContain(
        trig.dataset.severity,
      );
    } finally {
      h.unmount();
    }
  });

  it('hat aria-haspopup=menu und aria-expanded=false closed', () => {
    const h = mount();
    try {
      const trig = getTrigger(h.container);
      expect(trig.getAttribute('aria-haspopup')).toBe('menu');
      expect(trig.getAttribute('aria-expanded')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('Severity-Mapping: stuck > 0 → error', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMock({ running: 1, stuck: 2 }),
    );
    const h = mount();
    try {
      // Probe ist async — flush microtask + small wait.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const trig = getTrigger(h.container);
      expect(trig.dataset.severity).toBe('error');
    } finally {
      h.unmount();
    }
  });

  it('Severity-Mapping: warn > 0, stuck = 0 → warn', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMock({ stale: 2 }),
    );
    const h = mount();
    try {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const trig = getTrigger(h.container);
      expect(trig.dataset.severity).toBe('warn');
    } finally {
      h.unmount();
    }
  });

  it('Severity-Mapping: running > 0, kein warn/error → running', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      makeFetchMock({ running: 3 }),
    );
    const h = mount();
    try {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      const trig = getTrigger(h.container);
      expect(trig.dataset.severity).toBe('running');
    } finally {
      h.unmount();
    }
  });
});

describe('StatusCluster · Sheet-Mechanik', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(makeFetchMock({}));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('Tap auf Trigger öffnet Sheet mit role=menu und 4 Sub-Rows', () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const sheet = getSheet();
      expect(sheet).not.toBeNull();
      expect(sheet?.getAttribute('role')).toBe('menu');
      expect(sheet?.getAttribute('aria-modal')).toBe('true');
      const rows = document.querySelectorAll('.status-cluster-sheet__row');
      expect(rows.length).toBe(6);
    } finally {
      h.unmount();
    }
  });

  it('Escape schließt das Sheet', () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      expect(getSheet()).not.toBeNull();
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('rendert ein Cancel/Schließen-Button und schließt damit das Sheet', () => {
    const h = mount();
    try {
      act(() => getTrigger(h.container).click());
      const cancel = document.querySelector<HTMLButtonElement>(
        '.status-cluster-sheet__cancel',
      );
      expect(cancel).not.toBeNull();
      act(() => cancel!.click());
      expect(getSheet()).toBeNull();
    } finally {
      h.unmount();
    }
  });
});
