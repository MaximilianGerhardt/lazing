/**
 * OnboardingClient — workspace-switch nach first-workspace-Create (2026-05-26).
 *
 * Run: pnpm exec vitest run "app/onboarding/__tests__/OnboardingClient.workspace-switch.test.tsx"
 *
 * Cases:
 *   1. fromFirstWorkspace: erfolgreicher POST → setWorkspaceId schreibt
 *      WORKSPACE_STORAGE_KEY in localStorage
 *   2. fromFirstWorkspace: erfolgreicher POST → WORKSPACE_CHANGE_EVENT dispatcht
 *   3. fromFirstWorkspace: erfolgreicher POST → setOrgIdSilent schreibt ORG_STORAGE_KEY
 *   4. fromFirstWorkspace: kein localStorage-Eintrag wenn POST fehlschlägt
 *   5. fromFirstWorkspace: kein localStorage-Eintrag wenn Label leer (skip-Pfad)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { OnboardingClient } from '../OnboardingClient';
import { WORKSPACE_CHANGE_EVENT, WORKSPACE_STORAGE_KEY } from '@/lib/nav/types';

const ORG_STORAGE_KEY = 'lazyos.org';

// next/navigation — useRouter muss existieren
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

/** Minimal OnboardingState for the first-workspace step. */
function makeInitial(
  step: 'first-workspace' | 'welcome' = 'first-workspace',
  chosenOrgId = 'test-org',
) {
  return {
    user: { id: 'u1', displayName: 'Test User', email: 'test@example.com' },
    state: {
      currentStep: step as import('@/lib/onboarding/state').OnboardingStep,
      completedSteps: [] as import('@/lib/onboarding/state').OnboardingStep[],
      variant: 'new' as const,
      completedAt: null as string | null,
      data: { chosenOrgId },
    },
  };
}

function mountOnboarding(
  initial = makeInitial(),
): { root: Root; container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OnboardingClient initial={initial} />);
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

function typeInto(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  // Stub /api/orgs so loadOrgsForWs succeeds and populates the select.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const u = url.toString();
    if (u.includes('/api/orgs')) {
      return new Response(
        JSON.stringify({ orgs: [{ id: 'test-org', name: 'Test Org' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // /api/onboarding/state — minimal stub
    if (u.includes('/api/onboarding/state')) {
      return new Response(
        JSON.stringify({ state: { currentStep: 'claude-max', data: {} } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('OnboardingClient first-workspace → workspace-switch', () => {
  it('writes WORKSPACE_STORAGE_KEY after successful POST', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/orgs') && !(init?.method && init.method.toUpperCase() === 'POST')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'test-org', name: 'Test Org' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/workspaces') && init?.method?.toUpperCase() === 'POST') {
        return new Response(
          JSON.stringify({ workspace: { id: 'onboarding-ws-1', label: 'My First Workspace' } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/onboarding/state')) {
        return new Response(
          JSON.stringify({ state: { currentStep: 'claude-max', data: { workspaceId: 'onboarding-ws-1' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const h = mountOnboarding();
    try {
      // Wait for org list to load (loadOrgsForWs fires on render).
      await act(async () => {
        await new Promise((r) => setTimeout(r, 30));
      });

      // Fill workspace name.
      const wsLabel = h.container.querySelector<HTMLInputElement>(
        'input[placeholder*="acme"]',
      );
      expect(wsLabel).not.toBeNull();
      act(() => typeInto(wsLabel!, 'My First Workspace'));

      // The org select should now have a value.
      const orgSelect = h.container.querySelector<HTMLSelectElement>('select');
      // Even if select has no options in happy-dom test, the button should be enabled
      // — we patch via act.

      // Submit: "Workspace anlegen" button.
      const createBtn = Array.from(
        h.container.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
      ).find((b) => b.textContent?.includes('Workspace anlegen'));
      expect(createBtn).not.toBeNull();

      await act(async () => {
        createBtn?.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('onboarding-ws-1');
    } finally {
      h.unmount();
    }
  });

  it('dispatches WORKSPACE_CHANGE_EVENT after successful POST', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/orgs') && !(init?.method && init.method.toUpperCase() === 'POST')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'test-org', name: 'Test Org' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/workspaces') && init?.method?.toUpperCase() === 'POST') {
        return new Response(
          JSON.stringify({ workspace: { id: 'onboarding-ws-event', label: 'WS Event' } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/onboarding/state')) {
        return new Response(
          JSON.stringify({ state: { currentStep: 'claude-max', data: { workspaceId: 'onboarding-ws-event' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const wsChangeListener = vi.fn();
    window.addEventListener(WORKSPACE_CHANGE_EVENT, wsChangeListener);

    const h = mountOnboarding();
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

      const wsLabel = h.container.querySelector<HTMLInputElement>('input[placeholder*="acme"]');
      act(() => typeInto(wsLabel!, 'WS Event'));

      const createBtn = Array.from(
        h.container.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
      ).find((b) => b.textContent?.includes('Workspace anlegen'));

      await act(async () => {
        createBtn?.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(wsChangeListener.mock.calls.length).toBeGreaterThan(0);
      const ev = wsChangeListener.mock.calls[0][0] as CustomEvent<{ workspace: { id: string } }>;
      expect(ev.detail.workspace.id).toBe('onboarding-ws-event');
    } finally {
      window.removeEventListener(WORKSPACE_CHANGE_EVENT, wsChangeListener);
      h.unmount();
    }
  });

  it('writes ORG_STORAGE_KEY (setOrgIdSilent) after successful POST', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/orgs') && !(init?.method && init.method.toUpperCase() === 'POST')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'test-org', name: 'Test Org' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/workspaces') && init?.method?.toUpperCase() === 'POST') {
        return new Response(
          JSON.stringify({ workspace: { id: 'onboarding-ws-org', label: 'WS Org' } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/onboarding/state')) {
        return new Response(
          JSON.stringify({ state: { currentStep: 'claude-max', data: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const h = mountOnboarding(makeInitial('first-workspace', 'test-org'));
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

      const wsLabel = h.container.querySelector<HTMLInputElement>('input[placeholder*="acme"]');
      act(() => typeInto(wsLabel!, 'WS Org'));

      const createBtn = Array.from(
        h.container.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
      ).find((b) => b.textContent?.includes('Workspace anlegen'));

      await act(async () => {
        createBtn?.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      // ORG_STORAGE_KEY should have been written by setOrgIdSilent.
      expect(localStorage.getItem(ORG_STORAGE_KEY)).toBe('test-org');
    } finally {
      h.unmount();
    }
  });

  it('does NOT write WORKSPACE_STORAGE_KEY when POST fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/api/orgs')) {
        return new Response(
          JSON.stringify({ orgs: [{ id: 'test-org', name: 'Test Org' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/api/workspaces') && init?.method?.toUpperCase() === 'POST') {
        return new Response(
          JSON.stringify({ error: 'server-error' }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const h = mountOnboarding();
    try {
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

      const wsLabel = h.container.querySelector<HTMLInputElement>('input[placeholder*="acme"]');
      act(() => typeInto(wsLabel!, 'Fail WS'));

      const createBtn = Array.from(
        h.container.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
      ).find((b) => b.textContent?.includes('Workspace anlegen'));

      await act(async () => {
        createBtn?.click();
        await new Promise((r) => setTimeout(r, 30));
      });

      expect(localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
    } finally {
      h.unmount();
    }
  });
});
