/**
 * run-cockpit Surface + Renderer-Suppression Tests · Owner-Fix (2026-05-28).
 *
 * Owner-Befund 2026-05-28: nach der ersten Chat-Nachricht erschienen
 * extremst viele Surfaces auf einmal (6 Cards in 30s im example-website-2-Lauf).
 * Fix: eine `<surface:run-cockpit>`-Master-Card buendelt die 3 simultanen
 * Emit-Stellen (sub-workstreams + iterate-pipeline + iterate-version) zu
 * einem verfolgbaren Flow; der Renderer suppress't die Legacy-Cards solange
 * die Cockpit-Card aktiv ist (`RunCockpitRegistryProvider`).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/chat/__tests__/run-cockpit-surface.test.tsx
 *
 * Cases:
 *   1. RunCockpitCard rendert Phase-Stepper (6 Phasen, aktive Phase markiert).
 *   2. Sub-Workstream-Liste collapsed-default + expand-on-toggle.
 *   3. „Was kommt als naechstes"-Hint vorhanden.
 *   4. Token/Cost-Counter vorhanden wenn Werte gesetzt.
 *   5. Suppression: Cockpit + sub-workstreams gleicher Coord → sub-workstreams
 *      rendert null. Ohne Cockpit → Sub-WS-Card normal sichtbar (Back-Compat).
 *   6. Suppression: Cockpit + iterate-pipeline gleicher Coord → null.
 *   7. Suppression: Cockpit + iterate-version gleicher Coord → null.
 *   8. Suppression nur fuer SELBEN Coord-Key: Cockpit ws-A, sub-WS ws-B →
 *      sub-WS-Card bleibt sichtbar.
 *   9. Missing workspaceId/workstreamId → null (kein Render, kein Throw).
 *  10. Phase-Override aus Payload (phaseIndex).
 *  11. Default-Phase wenn ungueltige Phase im Payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface, RunCockpitRegistryProvider } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

// SubWorkstreamsCard / IteratePipelineCard / IterateVersionCard pollen via
// fetch beim Mount. In happy-dom existiert kein netzwerk-Backend → ohne
// Mock waeren das unendliche Fehler-Retries → setTimeout-Akkumulation →
// OOM. Setup/Teardown weiter unten.

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

function mountRunCockpit(data: unknown): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={() => undefined}
      >
        <RunCockpitRegistryProvider>
          {renderSurface('run-cockpit', data)}
        </RunCockpitRegistryProvider>
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

/**
 * Mounted BOTH the cockpit and a legacy surface in the same provider tree.
 * Used to verify suppression: legacy surface should render `null` when the
 * cockpit is active for the same coord-key.
 */
function mountCockpitPlusLegacy(
  cockpitData: unknown,
  legacyKind: 'sub-workstreams' | 'iterate-pipeline' | 'iterate-version',
  legacyData: unknown,
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={() => undefined}
      >
        <RunCockpitRegistryProvider>
          <div data-test="cockpit-slot">
            {renderSurface('run-cockpit', cockpitData)}
          </div>
          <div data-test="legacy-slot">
            {renderSurface(legacyKind, legacyData)}
          </div>
        </RunCockpitRegistryProvider>
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

/** Mounted legacy surface WITHOUT a cockpit (back-compat baseline). */
function mountLegacyOnly(
  legacyKind: 'sub-workstreams' | 'iterate-pipeline' | 'iterate-version',
  legacyData: unknown,
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={() => undefined}
      >
        <RunCockpitRegistryProvider>
          <div data-test="legacy-slot">
            {renderSurface(legacyKind, legacyData)}
          </div>
        </RunCockpitRegistryProvider>
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

beforeEach(() => {
  document.body.innerHTML = '';
  // never-resolve fetch — Polling-Loops der Legacy-Cards laufen sofort leer,
  // ohne setTimeout-Re-Scheduling. Eines pro Test damit der Mock-Counter
  // sauber bleibt.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => undefined)),
  );
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const COCKPIT_COMPLETE = {
  workspaceId: 'ws-1',
  workstreamId: 'wstr-1',
  phase: 'lead',
  phaseIndex: 3,
  phaseTotal: 6,
  workstreamName: 'example-website',
  subWorkstreams: [
    { role: 'iterate-lead', status: 'active', tokensOut: 558 },
    { role: 'roaster-1', status: 'pending', tokensOut: 0 },
    { role: 'roaster-2', status: 'pending', tokensOut: 0 },
  ],
  tokensTotal: 558,
  costCents: 12,
};

describe('run-cockpit surface — RunCockpitCard render', () => {
  it('renders the phase-stepper with 6 steps and marks the active phase', () => {
    const h = mountRunCockpit(COCKPIT_COMPLETE);
    try {
      const card = h.container.querySelector(
        '[data-test="run-cockpit-card"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-phase')).toBe('lead');

      const steps = h.container.querySelectorAll(
        '[data-test="run-cockpit-step"]',
      );
      expect(steps.length).toBe(6);

      const activeSteps = h.container.querySelectorAll(
        '[data-test="run-cockpit-step"][data-active="1"]',
      );
      expect(activeSteps.length).toBe(1);
      expect(
        (activeSteps[0] as HTMLElement).getAttribute('data-step'),
      ).toBe('lead');

      const doneSteps = h.container.querySelectorAll(
        '[data-test="run-cockpit-step"][data-done="1"]',
      );
      // phaseIndex=3 → 2 vorherige Phasen sind 'done'
      expect(doneSteps.length).toBe(2);
    } finally {
      h.unmount();
    }
  });

  it('renders the sub-workstream section collapsed by default and expands on toggle', () => {
    const h = mountRunCockpit(COCKPIT_COMPLETE);
    try {
      const section = h.container.querySelector(
        '[data-test="run-cockpit-subs-section"]',
      );
      expect(section).not.toBeNull();
      const toggle = h.container.querySelector(
        '[data-test="run-cockpit-subs-toggle"]',
      ) as HTMLButtonElement | null;
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute('data-collapsed')).toBe('1');

      // collapsed-default → list is not in the DOM
      let list = h.container.querySelector(
        '[data-test="run-cockpit-subs-list"]',
      );
      expect(list).toBeNull();

      // Expand
      act(() => {
        toggle?.click();
      });
      list = h.container.querySelector('[data-test="run-cockpit-subs-list"]');
      expect(list).not.toBeNull();
      const rows = h.container.querySelectorAll(
        '[data-test="run-cockpit-sub-row"]',
      );
      expect(rows.length).toBe(3);
    } finally {
      h.unmount();
    }
  });

  it('renders the next-step hint and the cost counter', () => {
    const h = mountRunCockpit(COCKPIT_COMPLETE);
    try {
      const hint = h.container.querySelector(
        '[data-test="run-cockpit-next-hint"]',
      );
      expect(hint).not.toBeNull();
      expect((hint as HTMLElement).textContent ?? '').toMatch(
        /Roaster|Consensus|Freigabe|verbessern/i,
      );

      const counter = h.container.querySelector(
        '[data-test="run-cockpit-cost-counter"]',
      );
      expect(counter).not.toBeNull();
      const counterText = (counter as HTMLElement).textContent ?? '';
      expect(counterText).toMatch(/tok/);
      expect(counterText).toMatch(/€/);
    } finally {
      h.unmount();
    }
  });

  it('renders nothing when workspaceId or workstreamId is missing', () => {
    const h1 = mountRunCockpit({ workstreamId: 'w1', phase: 'lead' });
    try {
      expect(
        h1.container.querySelector('[data-test="run-cockpit-card"]'),
      ).toBeNull();
    } finally {
      h1.unmount();
    }
    const h2 = mountRunCockpit({ workspaceId: 'ws-1', phase: 'lead' });
    try {
      expect(
        h2.container.querySelector('[data-test="run-cockpit-card"]'),
      ).toBeNull();
    } finally {
      h2.unmount();
    }
  });

  it('falls back to a default phase when payload phase is unknown', () => {
    const h = mountRunCockpit({
      workspaceId: 'ws-x',
      workstreamId: 'wstr-x',
      phase: 'invalid-phase-name',
    });
    try {
      const card = h.container.querySelector(
        '[data-test="run-cockpit-card"]',
      ) as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(card?.getAttribute('data-phase')).toBe('decompose');
    } finally {
      h.unmount();
    }
  });
});

describe('run-cockpit suppression of legacy surfaces (same coord_key)', () => {
  it('suppresses sub-workstreams when a cockpit exists for the same coord', () => {
    const h = mountCockpitPlusLegacy(
      COCKPIT_COMPLETE,
      'sub-workstreams',
      {
        workstreamId: 'wstr-1',
        masterWorkstreamId: 'wstr-1',
        workspaceId: 'ws-1',
      },
    );
    try {
      // Cockpit rendered
      expect(
        h.container.querySelector('[data-test="run-cockpit-card"]'),
      ).not.toBeNull();
      // legacy slot is empty (sub-workstreams suppressed → null)
      const legacySlot = h.container.querySelector(
        '[data-test="legacy-slot"]',
      ) as HTMLElement | null;
      expect(legacySlot).not.toBeNull();
      // SubWorkstreamsCard renders a wrapping element. After suppression the
      // slot has no children beyond the wrapping div.
      expect(legacySlot?.children.length ?? 0).toBe(0);
    } finally {
      h.unmount();
    }
  });

  it('renders sub-workstreams normally without a cockpit (back-compat)', () => {
    const h = mountLegacyOnly('sub-workstreams', {
      workstreamId: 'wstr-1',
      masterWorkstreamId: 'wstr-1',
      workspaceId: 'ws-1',
    });
    try {
      const legacySlot = h.container.querySelector(
        '[data-test="legacy-slot"]',
      ) as HTMLElement | null;
      expect(legacySlot).not.toBeNull();
      // Without cockpit suppression the SubWorkstreamsCard renders something
      // (at minimum a wrapping element).
      expect((legacySlot?.children.length ?? 0) > 0).toBe(true);
    } finally {
      h.unmount();
    }
  });

  it('suppresses iterate-pipeline when a cockpit exists for the same coord', () => {
    const h = mountCockpitPlusLegacy(
      COCKPIT_COMPLETE,
      'iterate-pipeline',
      {
        workstreamId: 'wstr-1',
        workspaceId: 'ws-1',
        maxVersion: 5,
      },
    );
    try {
      const legacySlot = h.container.querySelector(
        '[data-test="legacy-slot"]',
      ) as HTMLElement | null;
      expect(legacySlot).not.toBeNull();
      expect(legacySlot?.children.length ?? 0).toBe(0);
    } finally {
      h.unmount();
    }
  });

  it('suppresses iterate-version when a cockpit exists for the same coord', () => {
    const h = mountCockpitPlusLegacy(
      COCKPIT_COMPLETE,
      'iterate-version',
      {
        workstreamId: 'wstr-1',
        workspaceId: 'ws-1',
        versionN: 1,
        text: 'V1-Plan',
        costCents: 5,
      },
    );
    try {
      const legacySlot = h.container.querySelector(
        '[data-test="legacy-slot"]',
      ) as HTMLElement | null;
      expect(legacySlot).not.toBeNull();
      expect(legacySlot?.children.length ?? 0).toBe(0);
    } finally {
      h.unmount();
    }
  });

  it('does NOT suppress legacy surfaces from a DIFFERENT coord-key', () => {
    const h = mountCockpitPlusLegacy(
      // Cockpit registered for ws-1/wstr-1
      COCKPIT_COMPLETE,
      // Legacy surface lives on a DIFFERENT workstream
      'sub-workstreams',
      {
        workstreamId: 'wstr-OTHER',
        masterWorkstreamId: 'wstr-OTHER',
        workspaceId: 'ws-1',
      },
    );
    try {
      const legacySlot = h.container.querySelector(
        '[data-test="legacy-slot"]',
      ) as HTMLElement | null;
      expect(legacySlot).not.toBeNull();
      // Different coord → suppression does NOT apply, sub-workstreams renders.
      expect((legacySlot?.children.length ?? 0) > 0).toBe(true);
    } finally {
      h.unmount();
    }
  });
});
