/**
 * SubplanCard `initialCollapsed` Tests · Owner-Fix (2026-05-28).
 *
 * Owner-Live-Test 2026-05-28: child-Subplaene wurden bisher gleichzeitig mit
 * dem Parent-Subplan voll aufgeklappt emittiert (lib/plan-first/plan-
 * dispatch.ts:270 Schleife) — Owner: „extremst viele Surfaces auf einmal".
 * Fix: plan-dispatch setzt `collapsed:true` im Child-Payload; der Renderer
 * liest das Flag und uebergibt es als `initialCollapsed` an SubplanCard.
 * Card startet als Pill (Chevron), ein-Tap zum Ausklappen.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/chat/__tests__/subplan-initial-collapsed.test.tsx
 *
 * Cases:
 *   1. collapsed:true im Payload bei depth=1 → Pill-Variante (Chevron).
 *   2. collapsed:false oder fehlend → wie bisher (volle Card sichtbar).
 *   3. Pill-Tap expandiert die Card.
 *   4. depth>=2 ohne collapsed-Flag → weiter automatisch Pill (alte Heuristik).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={() => undefined}
      >
        {renderSurface('subplan', data)}
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

const VALID_PLAN_BASE = {
  id: 'plan-1',
  originalIntent: 'Erstelle eine Webseite',
  estimatedComplexity: 'M',
  proposedAt: 1700000000000,
  steps: [
    {
      id: 'step-1',
      index: 1,
      title: 'Aufbau klären',
      rationale: 'Information-Architektur vor Visual.',
    },
    {
      id: 'step-2',
      index: 2,
      title: 'Hero-Section schreiben',
      rationale: 'Erster Eindruck zaehlt.',
    },
  ],
};

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('SubplanCard initialCollapsed (Owner-Fix 2026-05-28)', () => {
  it('renders the pill variant when payload sets collapsed:true at depth=1', () => {
    const h = mount({
      ...VALID_PLAN_BASE,
      depth: 1,
      awaitingApproval: false,
      workstreamId: 'wstr-1',
      collapsed: true,
    });
    try {
      const pill = h.container.querySelector(
        '[data-test="subplan-pill-collapsed"]',
      );
      expect(pill).not.toBeNull();
      // Volle Card-Steps duerfen im collapsed-Zustand NICHT da sein.
      const steps = h.container.querySelectorAll('.srf-subplan__step');
      expect(steps.length).toBe(0);
    } finally {
      h.unmount();
    }
  });

  it('renders the full card when collapsed is missing or false (back-compat)', () => {
    const h = mount({
      ...VALID_PLAN_BASE,
      depth: 1,
      awaitingApproval: false,
      workstreamId: 'wstr-1',
      // no collapsed flag
    });
    try {
      const pill = h.container.querySelector(
        '[data-test="subplan-pill-collapsed"]',
      );
      expect(pill).toBeNull();
      const steps = h.container.querySelectorAll('.srf-subplan__step');
      expect(steps.length).toBe(VALID_PLAN_BASE.steps.length);
    } finally {
      h.unmount();
    }
  });

  it('does not collapse when collapsed:false is explicit (back-compat)', () => {
    const h = mount({
      ...VALID_PLAN_BASE,
      depth: 1,
      awaitingApproval: false,
      workstreamId: 'wstr-1',
      collapsed: false,
    });
    try {
      const pill = h.container.querySelector(
        '[data-test="subplan-pill-collapsed"]',
      );
      expect(pill).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('expands the pill on tap', () => {
    const h = mount({
      ...VALID_PLAN_BASE,
      depth: 1,
      awaitingApproval: false,
      workstreamId: 'wstr-1',
      collapsed: true,
    });
    try {
      const pill = h.container.querySelector(
        '[data-test="subplan-pill-collapsed"]',
      ) as HTMLButtonElement | null;
      expect(pill).not.toBeNull();
      act(() => {
        pill?.click();
      });
      // After expand: pill gone, full steps rendered.
      expect(
        h.container.querySelector('[data-test="subplan-pill-collapsed"]'),
      ).toBeNull();
      const steps = h.container.querySelectorAll('.srf-subplan__step');
      expect(steps.length).toBe(VALID_PLAN_BASE.steps.length);
    } finally {
      h.unmount();
    }
  });

  it('still auto-collapses at depth>=2 even without collapsed flag (legacy)', () => {
    const h = mount({
      ...VALID_PLAN_BASE,
      depth: 2,
      awaitingApproval: false,
      workstreamId: 'wstr-1',
      // no collapsed flag — depth>=2 erzwingt Pill durch SubplanCard selbst.
    });
    try {
      const pill = h.container.querySelector(
        '[data-test="subplan-pill-collapsed"]',
      );
      expect(pill).not.toBeNull();
    } finally {
      h.unmount();
    }
  });
});
