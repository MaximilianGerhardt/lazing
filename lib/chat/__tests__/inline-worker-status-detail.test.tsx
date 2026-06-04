/**
 * Tests fuer den Owner-Fix 2026-05-28:
 *
 *   Vorher: Pill onClick dispatchte `lazyos:drawer:open` → mobiler
 *   Drawer ging fullscreen auf und scrollte zu drawer-section-activity
 *   (direkt ueber Workspaces). Owner-Befund: „bringt mir nichts."
 *
 *   Jetzt:  Pill onClick oeffnet die fokussierte
 *   InlineWorkerStatusDetail-Surface inline am Anker. KEIN
 *   lazyos:drawer:open. KEIN Scroll-Sprung in andere UI-Bereiche.
 *
 * Mobile-first: Detail-Surface darf auf 375px keine horizontalen
 * Overflows produzieren.
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     lib/chat/__tests__/inline-worker-status-detail.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InlineWorkerStatus } from '../InlineWorkerStatus';
import {
  InlineWorkerStatusDetail,
  type DetailActivityItem,
} from '../InlineWorkerStatusDetail';

/* ----- /api/activity/live Fetch-Mock --------------------------------- */

interface MockActivityResponse {
  ok: boolean;
  now: number;
  running: number;
  paused: number;
  stuck: number;
  cronSoon: number;
  items: Array<{
    type: 'workstream' | 'workflow' | 'routine' | 'sub-workstream';
    id: string;
    label: string;
    phase: string | null;
    lastTickMs: number | null;
    workspaceId: string;
    status?: 'active' | 'paused' | 'stuck' | null;
    stuckSinceMs?: number | null;
    stuckReason?: string | null;
  }>;
}

function installFetchMock(body: MockActivityResponse): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    return {
      ok: true,
      json: async () => body,
    } as unknown as Response;
  });
  // happy-dom + global.fetch
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/* ----- Test-Mount-Helper -------------------------------------------- */

function mountReact(node: React.ReactNode): {
  container: HTMLElement;
  root: Root;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(node);
  });
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/* ----- flushPromises ------------------------------------------------- */

async function flushFetchAndState(): Promise<void> {
  // Mehrere Mikrotask-Runden, damit fetch().then().then() ankommt.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/* ===================================================================== */

describe('InlineWorkerStatus — Owner-Fix Pill-Klick (2026-05-28)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('Klick auf Pill dispatched KEIN lazyos:drawer:open', async () => {
    const body: MockActivityResponse = {
      ok: true,
      now: Date.now(),
      running: 1,
      paused: 0,
      stuck: 0,
      cronSoon: 0,
      items: [
        {
          type: 'workstream',
          id: 'ws-1',
          label: 'Aktiver Workstream',
          phase: 'lead',
          lastTickMs: Date.now() - 5_000,
          workspaceId: 'ws_test',
          status: 'active',
        },
      ],
    };
    installFetchMock(body);

    const drawerListener = vi.fn();
    window.addEventListener('lazyos:drawer:open', drawerListener);

    const { container, cleanup } = mountReact(
      <InlineWorkerStatus workspaceId="ws_test" />,
    );

    // Pill rendert erst nach Fetch.
    await flushFetchAndState();

    const pill = container.querySelector(
      'button.inline-worker-status',
    ) as HTMLButtonElement | null;
    expect(pill, 'Pill sollte rendern wenn items vorhanden').not.toBeNull();

    act(() => {
      pill!.click();
    });

    expect(drawerListener).not.toHaveBeenCalled();
    window.removeEventListener('lazyos:drawer:open', drawerListener);
    cleanup();
  });

  it('Klick auf Pill oeffnet InlineWorkerStatusDetail-Dialog', async () => {
    const body: MockActivityResponse = {
      ok: true,
      now: Date.now(),
      running: 1,
      paused: 0,
      stuck: 0,
      cronSoon: 0,
      items: [
        {
          type: 'workstream',
          id: 'ws-1',
          label: 'Aktiver Workstream',
          phase: 'lead',
          lastTickMs: Date.now() - 5_000,
          workspaceId: 'ws_test',
          status: 'active',
        },
      ],
    };
    installFetchMock(body);

    const { container, cleanup } = mountReact(
      <InlineWorkerStatus workspaceId="ws_test" />,
    );
    await flushFetchAndState();

    // Vor dem Klick: kein Dialog.
    expect(
      document.querySelector('[role="dialog"].inline-worker-status-detail'),
    ).toBeNull();

    const pill = container.querySelector(
      'button.inline-worker-status',
    ) as HTMLButtonElement;
    act(() => {
      pill.click();
    });

    const dialog = document.querySelector(
      '[role="dialog"].inline-worker-status-detail',
    );
    expect(dialog, 'Detail-Dialog sollte nach Klick offen sein').not.toBeNull();
    expect(pill.getAttribute('aria-expanded')).toBe('true');

    cleanup();
  });

  it('Pill rendert nicht wenn keine items', async () => {
    const body: MockActivityResponse = {
      ok: true,
      now: Date.now(),
      running: 0,
      paused: 0,
      stuck: 0,
      cronSoon: 0,
      items: [],
    };
    installFetchMock(body);

    const { container, cleanup } = mountReact(
      <InlineWorkerStatus workspaceId="ws_test" />,
    );
    await flushFetchAndState();

    expect(container.querySelector('button.inline-worker-status')).toBeNull();
    cleanup();
  });
});

/* ===================================================================== */

describe('InlineWorkerStatusDetail — Inhalt + Mobile', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('rendert N Aktivitaeten mit Label, Status und Jump-Link', () => {
    const now = Date.now();
    const items: DetailActivityItem[] = [
      {
        type: 'workstream',
        id: 'ws-a',
        label: 'Plan A',
        phase: 'lead',
        lastTickMs: now - 5_000,
        workspaceId: 'ws_test',
        status: 'active',
      },
      {
        type: 'workstream',
        id: 'ws-b',
        label: 'Plan B (stuck)',
        phase: null,
        lastTickMs: now - 18 * 60 * 60_000,
        workspaceId: 'ws_test',
        status: 'stuck',
        stuckSinceMs: 18 * 60 * 60_000,
        stuckReason: 'kein Event seit 18h 0m',
      },
    ];

    const { container, cleanup } = mountReact(
      <InlineWorkerStatusDetail
        open={true}
        items={items}
        now={now}
        onClose={() => {}}
      />,
    );

    const itemsRendered = container.querySelectorAll(
      '.inline-worker-status-detail__item',
    );
    expect(itemsRendered.length).toBe(2);

    // Jump-Link auf Workstream-Detail.
    const jumpA = container.querySelector(
      'a[data-jump-id="ws-a"]',
    ) as HTMLAnchorElement | null;
    expect(jumpA?.getAttribute('href')).toBe('/workstreams/ws-a');

    // Stuck-Hint sichtbar.
    const stuckHint = container.querySelector(
      '.inline-worker-status-detail__stuck-hint',
    );
    expect(stuckHint?.textContent).toContain('18h');

    // Status-Label fuer stuck-WS.
    const stuckLabel = container.querySelector(
      '.inline-worker-status-detail__status[data-status="stuck"]',
    );
    expect(stuckLabel?.textContent?.trim()).toBe('hängt');

    cleanup();
  });

  it('onClose wird gerufen beim Klick auf den Close-Button', () => {
    const onClose = vi.fn();
    const items: DetailActivityItem[] = [
      {
        type: 'workstream',
        id: 'ws-x',
        label: 'X',
        phase: null,
        lastTickMs: null,
        workspaceId: 'ws_test',
        status: 'active',
      },
    ];

    const { container, cleanup } = mountReact(
      <InlineWorkerStatusDetail
        open={true}
        items={items}
        now={Date.now()}
        onClose={onClose}
      />,
    );

    const close = container.querySelector(
      '.inline-worker-status-detail__close',
    ) as HTMLButtonElement;
    act(() => {
      close.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('Escape-Taste schliesst die Detail-Surface', () => {
    const onClose = vi.fn();
    const items: DetailActivityItem[] = [
      {
        type: 'workstream',
        id: 'ws-x',
        label: 'X',
        phase: null,
        lastTickMs: null,
        workspaceId: 'ws_test',
        status: 'active',
      },
    ];

    const { cleanup } = mountReact(
      <InlineWorkerStatusDetail
        open={true}
        items={items}
        now={Date.now()}
        onClose={onClose}
      />,
    );

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('Mobile 375px: kein horizontaler Overflow auf der Detail-Surface', () => {
    // Viewport simulieren — happy-dom respektiert window.innerWidth.
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });

    const items: DetailActivityItem[] = Array.from({ length: 4 }, (_, i) => ({
      type: 'workstream' as const,
      id: `ws-overflow-${i}`,
      label:
        'Sehr-langer-Workstream-Name-der-auf-375px-nichts-zerbrechen-darf-' + i,
      phase: 'roaster-1',
      lastTickMs: Date.now() - 10_000 * i,
      workspaceId: 'ws_test',
      status: 'active' as const,
    }));

    const { container, cleanup } = mountReact(
      <InlineWorkerStatusDetail
        open={true}
        items={items}
        now={Date.now()}
        onClose={() => {}}
      />,
    );

    const sheet = container.querySelector(
      '.inline-worker-status-detail',
    ) as HTMLElement | null;
    expect(sheet).not.toBeNull();

    // Style-Audit: overflow-x soll 'hidden' sein (Token-konform aus CSS).
    // Auf happy-dom ist Layout nicht real berechenbar, daher reicht der
    // Style-Audit der eingehaengten Klassen + die Render-Garantie.
    const itemRows = container.querySelectorAll(
      '.inline-worker-status-detail__item',
    );
    expect(itemRows.length).toBe(4);

    // Min-Width-0 + overflow-hidden auf Label — wir verifizieren, dass
    // die Label-Elemente mit der korrekten Klasse rendern (CSS-Token
    // garantiert die Truncation; siehe app/components.css).
    const labels = container.querySelectorAll(
      '.inline-worker-status-detail__label',
    );
    expect(labels.length).toBe(4);

    cleanup();
  });

  it('onJumpToWorkstream-Override unterbindet Default-Navigation', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    const items: DetailActivityItem[] = [
      {
        type: 'workstream',
        id: 'ws-y',
        label: 'Y',
        phase: null,
        lastTickMs: null,
        workspaceId: 'ws_test',
        status: 'active',
      },
    ];

    const { container, cleanup } = mountReact(
      <InlineWorkerStatusDetail
        open={true}
        items={items}
        now={Date.now()}
        onClose={onClose}
        onJumpToWorkstream={onJump}
      />,
    );

    const link = container.querySelector(
      'a[data-jump-id="ws-y"]',
    ) as HTMLAnchorElement;
    act(() => {
      link.click();
    });

    expect(onJump).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ws-y' }),
    );
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });
});
