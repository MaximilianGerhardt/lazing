/**
 * flow-coupling Surface Tests · Flow Studio P-now (2026-05-27).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/flow-coupling-surface.test.tsx
 *
 * Cases:
 *   1. Render: N missingTools + je ein „Koppeln"-Button + ein „Flow starten".
 *   2. „Flow starten" POSTet an /api/flow/<id>/run {workspaceId} (fetch gemockt)
 *      und ist gated — erst nach Kopplung (oder „Trotzdem starten") aktiv.
 *   3. „Koppeln" oeffnet die bestehende Credential-Eingabe (type=password).
 *   4. provider=null (reason 'unknown') → generischer Hinweis, KEIN Koppeln-Button.
 *   5. „Trotzdem starten" hebt das Gate auf.
 *   6. flowId/workspaceId fehlt → null (kein Render).
 *
 * SECURITY-Invariante (mitgeprueft): die Surface-Payload traegt kein secret;
 * der Secret-Pfad ist CredentialRequestCard → POST /api/connectors/.../credential.
 * Der „Flow starten"-POST-Body enthaelt NUR workspaceId — kein secret.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

interface Harness {
  root: Root;
  container: HTMLElement;
  pushed: string[];
  unmount: () => void;
}

function mount(data: unknown): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const pushed: string[] = [];
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={(c) => pushed.push(c)}
      >
        {renderSurface('flow-coupling', data)}
      </SurfaceActionProvider>,
    );
  });
  return {
    root,
    container,
    pushed,
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
function qa<T extends HTMLElement = HTMLElement>(
  c: HTMLElement,
  sel: string,
): T[] {
  return Array.from(c.querySelectorAll<T>(sel));
}

const SAMPLE = {
  flowId: 'flow-42',
  workspaceId: 'ws-1',
  missingTools: [
    {
      stepId: 's1',
      stepTitle: 'Rechnung an Kunde senden via Stripe',
      provider: 'stripe',
      neededCapabilities: ['invoice.create'],
      reason: 'credential',
    },
    {
      stepId: 's2',
      stepTitle: 'Kalender-Termin anlegen',
      provider: 'google-calendar',
      reason: 'profile',
    },
  ],
};

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('flow-coupling surface', () => {
  it('renders N missingTools, a Koppeln button each, and a Flow starten button', () => {
    const h = mount(SAMPLE);
    try {
      const card = q(h.container, '[data-test="surface-flow-coupling"]');
      expect(card).not.toBeNull();

      const rows = qa(h.container, '[data-test="flow-missing-tool"]');
      expect(rows).toHaveLength(2);

      // N1: stepTitle voll, ungekuerzt sichtbar.
      const text = h.container.textContent ?? '';
      expect(text).toContain('Rechnung an Kunde senden via Stripe');
      expect(text).toContain('Kalender-Termin anlegen');
      expect(text).toContain('Tools koppeln, dann läuft der Flow');

      // Provider-Chips + reason-Hinweise.
      expect(text).toContain('stripe');
      expect(text).toContain('API-Key/OAuth fehlt'); // reason=credential
      expect(text).toContain('Tool verbinden'); // reason=profile

      // Je ein „Koppeln"-Button (beide haben provider).
      expect(qa(h.container, '[data-test="flow-couple-btn"]')).toHaveLength(2);

      // Genau ein primaerer „Flow starten"-Button.
      const start = q(h.container, '[data-test="flow-start-btn"]');
      expect(start).not.toBeNull();
      expect(start?.textContent ?? '').toContain('Flow starten');
      // Gated: noch nicht alle gekoppelt → disabled.
      expect((start as HTMLButtonElement).disabled).toBe(true);
      expect(start?.getAttribute('data-enabled')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('Koppeln opens the existing credential entry (type=password, no chat secret)', () => {
    const h = mount(SAMPLE);
    try {
      // Vor Tap: keine Credential-Eingabe.
      expect(q(h.container, '[data-test="flow-couple-credential"]')).toBeNull();
      expect(q(h.container, 'input[type="password"]')).toBeNull();

      const coupleBtn = qa(h.container, '[data-test="flow-couple-btn"]')[0];
      act(() => {
        coupleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // Bestehende CredentialRequestCard ist eingebettet — Secret-Input type=password.
      const cred = q(h.container, '[data-test="flow-couple-credential"]');
      expect(cred).not.toBeNull();
      const pw = q<HTMLInputElement>(h.container, 'input[type="password"]');
      expect(pw).not.toBeNull();
      expect(pw?.getAttribute('autocomplete')).toBe('new-password');
    } finally {
      h.unmount();
    }
  });

  it('starts the flow via POST /api/flow/<id>/run with only workspaceId in the body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const h = mount(SAMPLE);
    try {
      // „Trotzdem starten" hebt das Gate auf, damit wir starten koennen.
      const force = q(h.container, '[data-test="flow-force-start-btn"]');
      expect(force).not.toBeNull();
      act(() => {
        force!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      const start = q<HTMLButtonElement>(
        h.container,
        '[data-test="flow-start-btn"]',
      );
      expect(start?.disabled).toBe(false);
      expect(start?.getAttribute('data-enabled')).toBe('true');

      await act(async () => {
        start!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Microtask-Drain fuer den await fetch im Handler.
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe('/api/flow/flow-42/run');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      // SECURITY: nur workspaceId, kein secret.
      expect(body).toEqual({ workspaceId: 'ws-1' });
      expect(JSON.stringify(body)).not.toMatch(/secret|password|token/i);

      // Done-State + pushAssistant.
      const card = q(h.container, '[data-test="surface-flow-coupling"]');
      expect(card?.getAttribute('data-state')).toBe('started');
      expect(h.pushed.some((m) => m.includes('Flow gestartet'))).toBe(true);
    } finally {
      h.unmount();
    }
  });

  it('renders a generic hint and no Koppeln button when provider is null (reason unknown)', () => {
    const h = mount({
      flowId: 'flow-9',
      workspaceId: 'ws-2',
      missingTools: [
        {
          stepId: 'sx',
          stepTitle: 'Irgendwas mit einem unklaren Tool',
          provider: null,
          reason: 'unknown',
        },
      ],
    });
    try {
      const row = q(h.container, '[data-test="flow-missing-tool"]');
      expect(row).not.toBeNull();
      // Kein Provider-Chip, kein Koppeln-Button.
      expect(q(h.container, '[data-test="flow-missing-tool-provider"]')).toBeNull();
      expect(q(h.container, '[data-test="flow-couple-btn"]')).toBeNull();
      // Generischer Hinweis sichtbar.
      const generic = q(h.container, '[data-test="flow-missing-tool-generic"]');
      expect(generic).not.toBeNull();
      expect(generic?.textContent ?? '').toContain('Tool für diesen Schritt wählen/verbinden');
    } finally {
      h.unmount();
    }
  });

  it('enables Flow starten immediately when there are no missing tools', () => {
    const h = mount({ flowId: 'f', workspaceId: 'w', missingTools: [] });
    try {
      expect(q(h.container, '[data-test="flow-coupling-empty"]')).not.toBeNull();
      const start = q<HTMLButtonElement>(
        h.container,
        '[data-test="flow-start-btn"]',
      );
      expect(start?.disabled).toBe(false);
      expect(start?.getAttribute('data-enabled')).toBe('true');
      // Kein „Trotzdem starten" noetig wenn alles gekoppelt.
      expect(q(h.container, '[data-test="flow-force-start-btn"]')).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('returns null when flowId or workspaceId is missing', () => {
    const h1 = mount({ workspaceId: 'w', missingTools: [] });
    try {
      expect(q(h1.container, '[data-test="surface-flow-coupling"]')).toBeNull();
    } finally {
      h1.unmount();
    }
    const h2 = mount({ flowId: 'f', missingTools: [] });
    try {
      expect(q(h2.container, '[data-test="surface-flow-coupling"]')).toBeNull();
    } finally {
      h2.unmount();
    }
  });
});
