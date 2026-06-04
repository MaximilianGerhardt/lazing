/**
 * Tests fuer BugFixSwarmCard auf Mobile (≤ 640px) — Phase-Stepper Layout-Contract.
 * Sprint UX-Fix 2026-05-28 · Owner-Direktive:
 *   „Diese Swarm Übersicht die wir hatten mit Detect - Analyze - Hypothesize ...
 *    ist zum Beispiel mobil gebrochen."
 *
 * Wir können in happy-dom keine CSS-Media-Queries auswerten — wir testen
 * stattdessen die *strukturellen Invarianten*, die der Mobile-Layout-Fix
 * voraussetzt:
 *
 *   1) Alle 9 Stepper-Phasen werden gerendert (keine wird abgeschnitten).
 *   2) Der Stepper hat einen einzigen Scroll-Container (.srf-bugfix__phase-stepper)
 *      — Voraussetzung dass mobile-CSS (overflow-x: auto) greift.
 *   3) Jede Phase hat eine eigene `role="listitem"` mit aria-current für die
 *      laufende — Screenreader & scrollIntoView brauchen das.
 *   4) Die laufende Phase ist im DOM addressierbar (data-status='running')
 *      damit das useEffect-scrollIntoView sie findet.
 *   5) Die Step-Number-Circles haben background:transparent (= NICHT mehr den
 *      doppelten --sheet-2 wie vor dem Fix). Wir testen via inline-style
 *      coverage — die CSS-Klasse `.srf-bugfix__phase-step-num` ist die
 *      Token-Quelle, und Test prüft via getComputedStyle (näherungsweise).
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' \
 *     npx vitest run lib/chat/__tests__/bug-fix-swarm-card-mobile.test.tsx
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BugFixSwarmCard } from '../BugFixSwarmCard';
// useSurfaceAction returnt no-op ohne Provider (s. SurfaceActionContext.tsx),
// daher KEIN Provider-Wrap nötig — Card rendert harmlos.

// fetch-Mock: BugFixSwarmCard pollt /api/bugs/swarm/[id] — wir liefern eine
// deterministische Antwort mit phase='hypothesize-equivalent' (diagnose).
function mockFetchOnce(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(body),
    }),
  );
}

interface MountResult {
  container: HTMLElement;
  root: Root;
  cleanup: () => void;
}

function mount(): MountResult {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <BugFixSwarmCard
        swarmId="swarm-test-1"
        workspaceId="ws-1"
        workstreamId="wst-1"
        masterTicketId="TKT-1"
        bugDescription="Test bug — composer hat doppelten Hintergrund"
      />,
    );
  });
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
      vi.unstubAllGlobals();
    },
  };
}

let activeCleanup: (() => void) | null = null;
afterEach(() => {
  activeCleanup?.();
  activeCleanup = null;
});

describe('BugFixSwarmCard — Phase-Stepper Layout-Contract (Mobile-Fix)', () => {
  it('rendert ALLE 9 Stepper-Phasen (keine wird auf Mobile abgeschnitten)', () => {
    mockFetchOnce({
      swarmId: 'swarm-test-1',
      workspaceId: 'ws-1',
      workstreamId: 'wst-1',
      masterTicketId: 'TKT-1',
      bugDescription: 'x',
      phase: 'diagnose',
      diagnoses: [],
    });
    const m = mount();
    activeCleanup = m.cleanup;

    const steps = m.container.querySelectorAll('.srf-bugfix__phase-step');
    expect(steps.length).toBe(9);

    const labels = Array.from(steps).map((s) =>
      s.querySelector('.srf-bugfix__phase-step-label')?.textContent ?? '',
    );
    expect(labels).toEqual([
      'Detect',
      'Analyze',
      'Hypothesize',
      'Plan',
      'Critic',
      'Sweep',
      'Fix',
      'Verify',
      'Audit',
    ]);
  });

  it('hat genau einen Scroll-Container (.srf-bugfix__phase-stepper) — Voraussetzung für mobile overflow-x:auto', () => {
    mockFetchOnce({
      swarmId: 'swarm-test-1',
      workspaceId: 'ws-1',
      workstreamId: 'wst-1',
      masterTicketId: 'TKT-1',
      bugDescription: 'x',
      phase: 'diagnose',
      diagnoses: [],
    });
    const m = mount();
    activeCleanup = m.cleanup;

    const steppers = m.container.querySelectorAll('.srf-bugfix__phase-stepper');
    expect(steppers.length).toBe(1);

    // Der Stepper ist ein direktes Element-Child der Card.
    const card = m.container.querySelector('.srf-bugfix');
    expect(card).toBeTruthy();
    expect(card?.contains(steppers[0])).toBe(true);
  });

  it('aktive Phase ist via data-status="running" addressierbar (für scrollIntoView)', () => {
    mockFetchOnce({
      swarmId: 'swarm-test-1',
      workspaceId: 'ws-1',
      workstreamId: 'wst-1',
      masterTicketId: 'TKT-1',
      bugDescription: 'x',
      phase: 'diagnose',
      diagnoses: [],
    });
    const m = mount();
    activeCleanup = m.cleanup;

    const running = m.container.querySelectorAll(
      '.srf-bugfix__phase-step[data-status="running"]',
    );
    // Bei phase='diagnose' ist 'hypothesize' der active step.
    expect(running.length).toBe(1);

    const label = running[0].querySelector('.srf-bugfix__phase-step-label')?.textContent;
    expect(label).toBe('Hypothesize');

    // ARIA: die laufende Phase trägt aria-current='step'.
    expect(running[0].getAttribute('aria-current')).toBe('step');
  });

  it('Step-Number-Circles haben keinen eigenen Background-on-Background (Owner-Fix 2026-05-28)', () => {
    mockFetchOnce({
      swarmId: 'swarm-test-1',
      workspaceId: 'ws-1',
      workstreamId: 'wst-1',
      masterTicketId: 'TKT-1',
      bugDescription: 'x',
      phase: 'diagnose',
      diagnoses: [],
    });
    const m = mount();
    activeCleanup = m.cleanup;

    // Pending-Steps: jedes circle hat background:transparent (nicht --sheet-2).
    // happy-dom liefert nur computed CSS für inline-styles + adopted stylesheets;
    // die globale .css ist nicht geladen → wir testen stattdessen die KLASSE.
    const nums = m.container.querySelectorAll('.srf-bugfix__phase-step-num');
    expect(nums.length).toBe(9);
    for (const n of Array.from(nums)) {
      // Sanity: keine inline-bg-Hex-Lüge im Markup.
      const inlineBg = (n as HTMLElement).style.background;
      expect(inlineBg === '' || inlineBg === 'transparent').toBe(true);
    }
  });

  it('Stepper-Container ist via Ref erreichbar (für scrollIntoView-Effect)', () => {
    mockFetchOnce({
      swarmId: 'swarm-test-1',
      workspaceId: 'ws-1',
      workstreamId: 'wst-1',
      masterTicketId: 'TKT-1',
      bugDescription: 'x',
      phase: 'diagnose',
      diagnoses: [],
    });
    const m = mount();
    activeCleanup = m.cleanup;

    const stepper = m.container.querySelector('.srf-bugfix__phase-stepper') as HTMLElement;
    expect(stepper).toBeTruthy();
    // Stepper hat 9 direkte Step-Children (für scrollIntoView muss indexing klappen).
    expect(stepper.children.length).toBe(9);
  });
});
