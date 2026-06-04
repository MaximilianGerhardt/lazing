/**
 * AllAccessToggle Tests · 2026-05-26.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/AllAccessToggle.test.tsx
 *
 * Cases (8):
 *   1. Mount liest aktuellen Mode (GET) → AN wenn freerein.
 *   2. Mount mit mode='ask' → AUS.
 *   3. AUS→AN-Klick zeigt ZUERST Disclaimer (KEIN PATCH vor Bestätigung).
 *   4. Disclaimer bestätigt (Checkbox + Confirm) → PATCH freerein → AN + onChange(true).
 *   5. AN→AUS-Klick → direkt PATCH ask → AUS + onChange(false), KEIN Disclaimer.
 *   6. PATCH-Fehler → Rollback auf vorherigen Zustand + Inline-Error.
 *   7. workspaceId='__root__' → KEIN GET, KEIN Render (Bug-Fix 2026-05-28
 *      Owner-Report: Tailscale-Console 403-Spam beim Öffnen der Root-View).
 *   8. GET → 403 (z.B. User ohne Membership) → fail-soft AUS, KEIN console.error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { AllAccessToggle } from '../AllAccessToggle';

interface Harness {
  root: Root;
  container: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange: any;
  unmount: () => void;
}

const WS = 'demo-pv-crm';

function mount(props: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onChange?: any;
} = {}): Harness {
  const onChange = props.onChange ?? vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AllAccessToggle workspaceId={WS} onChange={onChange} />);
  });
  return {
    root,
    container,
    onChange,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function findByTestId<T extends HTMLElement = HTMLElement>(
  c: HTMLElement,
  id: string,
): T {
  const el = c.querySelector<T>(`[data-test="${id}"]`);
  if (!el) throw new Error(`data-test ${id} not found`);
  return el;
}

/**
 * GET-mock returning a given mode for the workspace-mode endpoint AND a fixed
 * `null` for the user-default endpoint. Used when we want to assert behaviour
 * that's driven purely by the workspace-mode value.
 */
function mockGet(mode: string | null): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/user/preferences')) {
      return new Response(
        JSON.stringify({ defaultPermissionMode: null, hasPreferencesRow: false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ mode }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/**
 * Owner-Fix Live-Test 2026-05-28 — Mock the BOTH endpoints separately, so we
 * can verify that the user-default fallback only kicks in when the workspace
 * has no explicit mode.
 */
function mockGetWithUserDefault(
  workspaceMode: string | null,
  userDefault: string | null,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes('/api/user/preferences')) {
      return new Response(
        JSON.stringify({
          defaultPermissionMode: userDefault,
          hasPreferencesRow: userDefault !== null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ mode: workspaceMode }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** Drives a fetch mock: first call (GET) returns mode, later (PATCH) returns 200 ok. */
function mockGetThenPatch(
  getMode: string | null,
  patchOk = true,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = String(url);
    if (method === 'GET') {
      if (u.includes('/api/user/preferences')) {
        // Default no user-default in PATCH-flow tests — they care about the
        // workspace mode, not the fallback.
        return new Response(
          JSON.stringify({
            defaultPermissionMode: null,
            hasPreferencesRow: false,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ mode: getMode }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // PATCH
    if (!patchOk) {
      return new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body = JSON.parse((init?.body as string) ?? '{}');
    return new Response(JSON.stringify({ ok: true, mode: body.mode }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

/** Flush mount GET + state. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('AllAccessToggle', () => {
  it('reads current mode on mount → ON when freerein', async () => {
    const fetchMock = mockGet('freerein');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      // GET should have been called against the exact route.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain(
        `/api/permission/${WS}/mode`,
      );
      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('true');
    } finally {
      h.unmount();
    }
  });

  it("reads mode='ask' on mount → OFF", async () => {
    const fetchMock = mockGet('ask');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('OFF→ON click shows disclaimer FIRST, no PATCH before confirm', async () => {
    const fetchMock = mockGetThenPatch('ask');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      // Only the mount-GET so far.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const trigger = findByTestId<HTMLButtonElement>(
        h.container,
        'all-access-trigger',
      );
      act(() => {
        trigger.click();
      });

      // Disclaimer present.
      const disclaimer = h.container.querySelector(
        '[data-test="all-access-disclaimer"]',
      );
      expect(disclaimer).not.toBeNull();

      // CRUCIAL: no PATCH fired yet (still only the GET).
      const patchCalls = fetchMock.mock.calls.filter(
        (c) => ((c[1] as RequestInit)?.method ?? 'GET').toUpperCase() === 'PATCH',
      );
      expect(patchCalls.length).toBe(0);

      // Still OFF.
      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('confirm in disclaimer → PATCH freerein → ON + onChange(true)', async () => {
    const fetchMock = mockGetThenPatch('ask');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const onChange = vi.fn();
    const h = mount({ onChange });
    try {
      await settle();

      const trigger = findByTestId<HTMLButtonElement>(
        h.container,
        'all-access-trigger',
      );
      act(() => {
        trigger.click();
      });

      // Confirm is disabled until risk accepted.
      const confirm = findByTestId<HTMLButtonElement>(
        h.container,
        'all-access-confirm',
      );
      expect(confirm.disabled).toBe(true);

      const checkbox = findByTestId<HTMLInputElement>(
        h.container,
        'all-access-risk-checkbox',
      );
      act(() => {
        checkbox.click();
      });
      expect(confirm.disabled).toBe(false);

      await act(async () => {
        confirm.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      // Exactly one PATCH with mode=freerein.
      const patchCalls = fetchMock.mock.calls.filter(
        (c) => ((c[1] as RequestInit)?.method ?? 'GET').toUpperCase() === 'PATCH',
      );
      expect(patchCalls.length).toBe(1);
      const patchBody = JSON.parse(
        ((patchCalls[0][1] as RequestInit).body as string) ?? '{}',
      );
      expect(patchBody.mode).toBe('freerein');

      // Toggle now ON, onChange(true), disclaimer gone.
      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('true');
      expect(onChange).toHaveBeenCalledWith(true);
      expect(
        h.container.querySelector('[data-test="all-access-disclaimer"]'),
      ).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('ON→OFF click → direct PATCH ask → OFF + onChange(false), no disclaimer', async () => {
    const fetchMock = mockGetThenPatch('freerein');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const onChange = vi.fn();
    const h = mount({ onChange });
    try {
      await settle();
      // Starts ON.
      expect(
        findByTestId(h.container, 'all-access-root').getAttribute(
          'data-full-access',
        ),
      ).toBe('true');

      const trigger = findByTestId<HTMLButtonElement>(
        h.container,
        'all-access-trigger',
      );
      await act(async () => {
        trigger.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      // No disclaimer when disabling.
      expect(
        h.container.querySelector('[data-test="all-access-disclaimer"]'),
      ).toBeNull();

      const patchCalls = fetchMock.mock.calls.filter(
        (c) => ((c[1] as RequestInit)?.method ?? 'GET').toUpperCase() === 'PATCH',
      );
      expect(patchCalls.length).toBe(1);
      const patchBody = JSON.parse(
        ((patchCalls[0][1] as RequestInit).body as string) ?? '{}',
      );
      expect(patchBody.mode).toBe('ask');

      expect(
        findByTestId(h.container, 'all-access-root').getAttribute(
          'data-full-access',
        ),
      ).toBe('false');
      expect(onChange).toHaveBeenCalledWith(false);
    } finally {
      h.unmount();
    }
  });

  // Bug-Fix 2026-05-28 — Owner-Report Tailscale-Console:
  //   `GET /api/permission/__root__/mode → 403` beim Öffnen.
  // Root-Cause: `__root__` ist virtuell (server/workspace-session.ts:94), keine
  // Membership möglich. Honest fix in AllAccessToggle: nicht rendern, nicht fetchen.
  it('synthetic __root__ workspace → no GET, no render (bug-fix 2026-05-28)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'ask' }), { status: 200 }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => {
        root.render(<AllAccessToggle workspaceId="__root__" />);
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      // NO fetch fired (no 403 in the console of the Owner's browser).
      expect(fetchMock).not.toHaveBeenCalled();
      // NO rendered pill.
      expect(
        container.querySelector('[data-test="all-access-root"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  // Defense-in-depth: any future caller that accidentally fires on a non-member
  // workspace (legitimate 403 response) must NOT spam console.error and must
  // fail-soft to OFF — the route remains unchanged, only the client is polite.
  it('GET → 403 (non-member workspace) → fail-soft OFF, no console.error', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const h = mount();
    try {
      await settle();
      const root = findByTestId(h.container, 'all-access-root');
      // Fail-soft OFF (sicherer Default).
      expect(root.getAttribute('data-full-access')).toBe('false');
      // No error spam ORIGINATING FROM AllAccessToggle's own code path —
      // the 403 is handled silently in the .then() branch, not surfaced
      // through .catch() → console.error. We filter out React's test-env
      // warnings ("not configured to support act(...)") which are noise from
      // the harness, not from the component under test.
      const productionErrors = consoleErr.mock.calls.filter((call) => {
        const msg = String(call[0] ?? '');
        return !msg.includes('act(...)') && !msg.includes('configured');
      });
      expect(productionErrors).toEqual([]);
    } finally {
      h.unmount();
      consoleErr.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Owner-Fix Live-Test 2026-05-28 — User-Default Fallback bei Mount.
  //
  //   Hierarchie (höchstes wins):
  //     1. Workspace-Mode explizit gesetzt → wins.
  //     2. User-Default-Mode               → fallback.
  //     3. Sicherer Default (OFF / 'ask')  → letzte Bastion.
  // -------------------------------------------------------------------------

  it('workspace-mode=null + user-default=freerein → fallback aktiviert Pill (user-default-fallback-on)', async () => {
    const fetchMock = mockGetWithUserDefault(/* workspaceMode */ null, /* userDefault */ 'freerein');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      // Beide Endpoints wurden konsultiert: WS-Mode (null) → User-Default (freerein).
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes(`/api/permission/${WS}/mode`))).toBe(true);
      expect(calls.some((u) => u.includes('/api/user/preferences'))).toBe(true);

      const root = findByTestId(h.container, 'all-access-root');
      // Pill zeigt ON, weil User-Default ON ist.
      expect(root.getAttribute('data-full-access')).toBe('true');
    } finally {
      h.unmount();
    }
  });

  it('expliziter Workspace-Mode "ask" überstimmt User-Default "freerein" (ws-mode-wins)', async () => {
    const fetchMock = mockGetWithUserDefault(/* workspaceMode */ 'ask', /* userDefault */ 'freerein');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      // User-Default-GET wurde NICHT konsultiert — WS-Mode war explizit.
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/api/user/preferences'))).toBe(false);

      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('workspace-mode=null + user-default=null → OFF (no-fallback-source)', async () => {
    const fetchMock = mockGetWithUserDefault(null, null);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('User-Default "freerein-with-audit" aktiviert Pill (audit-mode-fallback)', async () => {
    const fetchMock = mockGetWithUserDefault(null, 'freerein-with-audit');
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('true');
    } finally {
      h.unmount();
    }
  });

  it('Workspace-GET 403 (kein Member) → KEIN User-Default-Leak (forbidden-no-fallback)', async () => {
    // Defense-in-depth: in einem Workspace, in dem der User KEIN Mitglied ist,
    // darf der User-Default NICHT als Spiegel reinlaufen. Pill bleibt AUS.
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes('/api/user/preferences')) {
        // Würde 'freerein' liefern, falls die Komponente jemals fragt.
        return new Response(
          JSON.stringify({
            defaultPermissionMode: 'freerein',
            hasPreferencesRow: true,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const h = mount();
    try {
      await settle();
      // User-Default-GET darf NICHT gefeuert worden sein.
      const calls = fetchMock.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/api/user/preferences'))).toBe(false);

      const root = findByTestId(h.container, 'all-access-root');
      expect(root.getAttribute('data-full-access')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('PATCH failure → rollback to previous state + inline error', async () => {
    // Start ON, disable → PATCH fails → rollback to ON.
    const fetchMock = mockGetThenPatch('freerein', /* patchOk */ false);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      fetchMock as unknown as typeof fetch,
    );

    const onChange = vi.fn();
    const h = mount({ onChange });
    try {
      await settle();
      expect(
        findByTestId(h.container, 'all-access-root').getAttribute(
          'data-full-access',
        ),
      ).toBe('true');

      const trigger = findByTestId<HTMLButtonElement>(
        h.container,
        'all-access-trigger',
      );
      await act(async () => {
        trigger.click();
        await new Promise((r) => setTimeout(r, 10));
      });

      // Rolled back to ON (previous state).
      expect(
        findByTestId(h.container, 'all-access-root').getAttribute(
          'data-full-access',
        ),
      ).toBe('true');
      // Error surfaced.
      const err = h.container.querySelector('[data-test="all-access-error"]');
      expect(err).not.toBeNull();
      // onChange must NOT fire on failure.
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      h.unmount();
    }
  });
});
