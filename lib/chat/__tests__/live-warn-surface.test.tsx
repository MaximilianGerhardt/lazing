/**
 * Stream X1 (2026-05-28) — live-warn surface tests.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/live-warn-surface.test.tsx
 *
 * Coverage:
 *   1. Renders OK weiter + Nein-ich-prüfe-erst buttons + verbatim copy.
 *   2. Tapping "OK weiter" POSTs decision:'ack' to /api/workspaces/.../live-warn-ack
 *      and switches to data-state="acked".
 *   3. Tapping "Nein, ich prüfe erst" POSTs decision:'decline' and switches to
 *      data-state="declined".
 *   4. POST body contains ONLY { decision } — no secret / no workspaceId in body.
 *   5. Missing workspaceId → null (no render).
 *   6. SECURITY: no fields in body or DOM resembling a secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
      <SurfaceActionProvider reply={() => undefined} pushAssistant={() => undefined}>
        {renderSurface('live-warn', data)}
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

describe('live-warn surface', () => {
  it('renders headline + both action buttons + verbatim safety copy', () => {
    const h = mount({ workspaceId: 'ws-live-1' });
    try {
      const card = q(h.container, '[data-test="surface-live-warn"]');
      expect(card).not.toBeNull();
      const text = h.container.textContent ?? '';
      expect(text).toContain('Du hast LIVE-Mode aktiv');
      expect(text).toContain('echte Kosten');
      expect(q(h.container, '[data-test="live-warn-ack-btn"]')).not.toBeNull();
      expect(q(h.container, '[data-test="live-warn-decline-btn"]')).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('"OK weiter" POSTs decision:ack and switches to data-state=acked', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, beliefId: 'BLF-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const h = mount({ workspaceId: 'ws-live-1' });
    try {
      const btn = q<HTMLButtonElement>(h.container, '[data-test="live-warn-ack-btn"]');
      expect(btn).not.toBeNull();
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('/api/workspaces/ws-live-1/live-warn-ack');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toEqual({ decision: 'ack' });

      // SECURITY: body has nothing else.
      expect(Object.keys(body)).toEqual(['decision']);

      // State flipped to acked.
      const card = q(h.container, '[data-test="surface-live-warn"]');
      expect(card?.getAttribute('data-state')).toBe('acked');
    } finally {
      h.unmount();
    }
  });

  it('"Nein, ich prüfe erst" POSTs decision:decline and switches to data-state=declined', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, beliefId: 'BLF-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const h = mount({ workspaceId: 'ws-live-2' });
    try {
      const btn = q<HTMLButtonElement>(
        h.container,
        '[data-test="live-warn-decline-btn"]',
      );
      await act(async () => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toEqual({ decision: 'decline' });

      const card = q(h.container, '[data-test="surface-live-warn"]');
      expect(card?.getAttribute('data-state')).toBe('declined');
    } finally {
      h.unmount();
    }
  });

  it('missing workspaceId → null (no render)', () => {
    const h = mount({});
    try {
      expect(q(h.container, '[data-test="surface-live-warn"]')).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('SECURITY: DOM contains no plaintext secret pattern', () => {
    const h = mount({ workspaceId: 'ws-live-sec' });
    try {
      const text = h.container.textContent ?? '';
      expect(text).not.toMatch(/sk_live_/);
      expect(text).not.toMatch(/sk_test_/);
      expect(text).not.toMatch(/Bearer [A-Za-z0-9]{20,}/);
    } finally {
      h.unmount();
    }
  });
});
