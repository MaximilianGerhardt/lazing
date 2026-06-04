/**
 * CreateWorkspaceCard — onSuccess ruft setWorkspaceId (2026-05-26).
 *
 * Run: pnpm exec vitest run "app/orgs/\[id\]/__tests__/CreateWorkspaceCard.test.tsx"
 *
 * Cases:
 *   1. onSuccess nach erfolgreichem POST → setWorkspaceId mit neuer ID aufgerufen
 *   2. onSuccess schreibt WORKSPACE_STORAGE_KEY in localStorage
 *   3. onSuccess dispatcht WORKSPACE_CHANGE_EVENT
 *   4. Kein setWorkspaceId-Aufruf bei 4xx-Fehler (Form bleibt offen)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { CreateWorkspaceCard } from '../CreateWorkspaceCard';
import { WORKSPACE_CHANGE_EVENT, WORKSPACE_STORAGE_KEY } from '@/lib/nav/types';

// next/navigation muss gemockt werden damit useRouter nicht wirft.
//
// Owner-Fix Live-Test 2026-05-28: wir machen `push` modul-weit observable,
// damit der Auto-Switch-Test (push('/?ws=<id>')) ihn als Spion auslesen kann.
const routerPush = vi.fn();
const routerRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: routerRefresh,
    push: routerPush,
    replace: vi.fn(),
  }),
}));

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mountCard(props: { orgId?: string; orgName?: string } = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <CreateWorkspaceCard
        orgId={props.orgId ?? 'demo-pv'}
        orgName={props.orgName ?? 'Demo PV'}
        canCreate
      />,
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

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  routerPush.mockClear();
  routerRefresh.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('CreateWorkspaceCard → workspace-switch on create', () => {
  it('calls setWorkspaceId (writes WORKSPACE_STORAGE_KEY) after successful POST', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      return new Response(
        JSON.stringify({
          workspace: {
            id: 'new-ws-123',
            label: body.label ?? 'Test WS',
            organizationId: 'demo-pv',
            workspaceType: 'product',
            contextGroup: null,
            sensitivity: 'low',
            credentialIsolation: 'inherit',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const h = mountCard({ orgId: 'demo-pv' });
    try {
      // Open the card.
      const openBtn = h.container.querySelector<HTMLButtonElement>('button[aria-label*="anlegen"]');
      expect(openBtn).not.toBeNull();
      act(() => { openBtn?.click(); });

      // Fill in the label.
      const labelInput = h.container.querySelector<HTMLInputElement>('[data-testid="new-ws-label"]');
      expect(labelInput).not.toBeNull();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      act(() => {
        setter?.call(labelInput!, 'New WS');
        labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // Submit.
      const submitBtn = h.container.querySelector<HTMLButtonElement>('[data-testid="new-ws-submit"]');
      expect(submitBtn).not.toBeNull();
      await act(async () => {
        submitBtn?.click();
        await new Promise((r) => setTimeout(r, 20));
      });

      // setWorkspaceId should have written to localStorage.
      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('new-ws-123');
    } finally {
      h.unmount();
    }
  });

  it('dispatches WORKSPACE_CHANGE_EVENT with the new id', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          workspace: {
            id: 'ws-event-check',
            label: 'Event Check',
            organizationId: 'org-x',
            workspaceType: 'default',
            contextGroup: null,
            sensitivity: 'low',
            credentialIsolation: 'inherit',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const wsChangeListener = vi.fn();
    window.addEventListener(WORKSPACE_CHANGE_EVENT, wsChangeListener);

    const h = mountCard({ orgId: 'org-x' });
    try {
      act(() => {
        h.container.querySelector<HTMLButtonElement>('button[aria-label*="anlegen"]')?.click();
      });

      const labelInput = h.container.querySelector<HTMLInputElement>('[data-testid="new-ws-label"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      act(() => {
        setter?.call(labelInput!, 'Event Check');
        labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => {
        h.container.querySelector<HTMLButtonElement>('[data-testid="new-ws-submit"]')?.click();
        await new Promise((r) => setTimeout(r, 20));
      });

      expect(wsChangeListener).toHaveBeenCalledTimes(1);
      const ev = wsChangeListener.mock.calls[0][0] as CustomEvent<{ workspace: { id: string } }>;
      expect(ev.detail.workspace.id).toBe('ws-event-check');
    } finally {
      window.removeEventListener(WORKSPACE_CHANGE_EVENT, wsChangeListener);
      h.unmount();
    }
  });

  // Owner-Fix Live-Test 2026-05-28 — Auto-Switch in den frischen Workspace.
  // Vor dem Fix blieb der User auf /orgs/[id] stehen; jetzt navigieren wir
  // hart nach `/?ws=<newId>` (kanonischer Lande-Pfad, siehe app/page.tsx).
  it('router.push(/?ws=<id>) nach erfolgreichem Create (auto-switch-to-chat)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          workspace: {
            id: 'auto-switch-ws',
            label: 'Auto Switch',
            organizationId: 'org-x',
            workspaceType: 'default',
            contextGroup: null,
            sensitivity: 'low',
            credentialIsolation: 'inherit',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const h = mountCard({ orgId: 'org-x' });
    try {
      act(() => {
        h.container
          .querySelector<HTMLButtonElement>('button[aria-label*="anlegen"]')
          ?.click();
      });

      const labelInput = h.container.querySelector<HTMLInputElement>(
        '[data-testid="new-ws-label"]',
      );
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      act(() => {
        setter?.call(labelInput!, 'Auto Switch');
        labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => {
        h.container
          .querySelector<HTMLButtonElement>('[data-testid="new-ws-submit"]')
          ?.click();
        await new Promise((r) => setTimeout(r, 20));
      });

      // Auto-Switch: push wurde mit /?ws=<id> aufgerufen.
      expect(routerPush).toHaveBeenCalledTimes(1);
      expect(routerPush.mock.calls[0][0]).toBe('/?ws=auto-switch-ws');
    } finally {
      h.unmount();
    }
  });

  it('encodiert die Workspace-ID im URL-Param (encoded-ws-id)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          workspace: {
            id: 'ws with space',
            label: 'Edge Case',
            organizationId: 'org-x',
            workspaceType: 'default',
            contextGroup: null,
            sensitivity: 'low',
            credentialIsolation: 'inherit',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const h = mountCard({ orgId: 'org-x' });
    try {
      act(() => {
        h.container
          .querySelector<HTMLButtonElement>('button[aria-label*="anlegen"]')
          ?.click();
      });
      const labelInput = h.container.querySelector<HTMLInputElement>(
        '[data-testid="new-ws-label"]',
      );
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      act(() => {
        setter?.call(labelInput!, 'Edge Case');
        labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => {
        h.container
          .querySelector<HTMLButtonElement>('[data-testid="new-ws-submit"]')
          ?.click();
        await new Promise((r) => setTimeout(r, 20));
      });

      // encodeURIComponent → spaces become %20.
      expect(routerPush.mock.calls[0][0]).toBe('/?ws=ws%20with%20space');
    } finally {
      h.unmount();
    }
  });

  it('does NOT write to localStorage when POST returns 4xx', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: 'id-taken', message: 'ID existiert bereits' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchMock as unknown as typeof fetch);

    const h = mountCard({ orgId: 'org-y' });
    try {
      act(() => {
        h.container.querySelector<HTMLButtonElement>('button[aria-label*="anlegen"]')?.click();
      });

      const labelInput = h.container.querySelector<HTMLInputElement>('[data-testid="new-ws-label"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      act(() => {
        setter?.call(labelInput!, 'Conflict WS');
        labelInput!.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await act(async () => {
        h.container.querySelector<HTMLButtonElement>('[data-testid="new-ws-submit"]')?.click();
        await new Promise((r) => setTimeout(r, 20));
      });

      // No switch on error.
      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    } finally {
      h.unmount();
    }
  });
});
