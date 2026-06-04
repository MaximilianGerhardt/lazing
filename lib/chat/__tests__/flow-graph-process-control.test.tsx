/**
 * flow-graph Prozess-Kontrolle · W2.2 (2026-05-30).
 *
 * Owner-Befund (verbatim): der Lauf muss am Handy SICHTbar UND STEUERbar sein
 * („Übersicht UND Kontrolle"). Diese Tests decken die W2.2-Bahn ab:
 *
 *   1. Stufen×Spuren-Layout: parallele Stufe = benannte Fork-Gruppe
 *      („⑂ parallel · N") + eingerückte Lanes; sequenzielle Stufe = ein Knoten.
 *   2. Join-Marker: eine Stufe, deren Knoten in-degree>1 hat, trägt den Join.
 *   3. needs-input-Knoten ist AKTIONIERBAR → der Detail-Button ruft DENSELBEN
 *      executeGateAction-Pfad wie der ActionDeck-Pin: er klickt die echte
 *      Gate-Stream-Card im DOM (EIN Klick, kein Doppel-Submit, kein zweites
 *      fetch).
 *   4. failed-Knoten → „Neu starten" (reply-Pfad, verbatim Step-Label).
 *   5. done-Knoten mit previewUrl → „Vorschau öffnen" (Link, target=_blank).
 *   6. Knoten ohne erlaubte Aktion (idle/running/done-ohne-URL) → KEIN Button.
 *   7. Anti-Proliferation: run-cockpit aktiv → flow-graph-Card supprimiert sich.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run \
 *     lib/chat/__tests__/flow-graph-process-control.test.tsx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { renderSurface, RunCockpitRegistryProvider } from '../SurfaceRenderer';
import { SurfaceActionProvider } from '../SurfaceActionContext';

interface Harness {
  root: Root;
  container: HTMLElement;
  unmount: () => void;
}

/** Mountet eine flow-graph-Surface; optional eine echte reply-Spionin. */
function mount(
  data: unknown,
  opts: { reply?: (t: string) => void; withCockpit?: unknown } = {},
): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SurfaceActionProvider
        reply={opts.reply ?? (() => undefined)}
        pushAssistant={() => undefined}
      >
        <RunCockpitRegistryProvider>
          {opts.withCockpit
            ? renderSurface('run-cockpit', opts.withCockpit)
            : null}
          {renderSurface('flow-graph', data)}
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

function nodes(c: HTMLElement): HTMLElement[] {
  return Array.from(c.querySelectorAll<HTMLElement>('[data-test="flow-node"]'));
}
function nodeById(c: HTMLElement, id: string): HTMLElement {
  const el = c.querySelector<HTMLElement>(`[data-test="flow-node"][data-node-id="${id}"]`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
}
function openNode(c: HTMLElement, id: string): void {
  act(() => {
    nodeById(c, id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('flow-graph Stufen×Spuren-Layout (W2.2)', () => {
  it('renders a parallel level as a named fork group with indented lanes', () => {
    // root → (b, c) parallel → join d. b und c sitzen auf Stufe 1.
    const h = mount({
      title: 'Website-Flow',
      nodes: [
        { id: 'root', label: 'Aufbau', status: 'done' },
        { id: 'b', label: 'Copy', status: 'running' },
        { id: 'c', label: 'Design', status: 'running' },
        { id: 'd', label: 'Assembly', status: 'idle' },
      ],
      edges: [
        { from: 'root', to: 'b' },
        { from: 'root', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    });
    try {
      // Genau EINE Fork-Gruppe (die parallele Stufe mit b+c).
      const forks = h.container.querySelectorAll('[data-test="flow-fork-group"]');
      expect(forks).toHaveLength(1);
      // Fork-Header benennt „parallel · 2".
      const count = h.container.querySelector('[data-test="flow-fork-count"]');
      expect(count?.textContent ?? '').toContain('2');
      const header = h.container.querySelector('[data-test="flow-fork-header"]');
      expect(header?.textContent ?? '').toContain('parallel');
      // Die parallele Stufe ist als data-parallel="true" markiert; root NICHT.
      const lvls = Array.from(
        h.container.querySelectorAll<HTMLElement>('[data-test="flow-level"]'),
      );
      const parallelFlags = lvls.map((l) => l.getAttribute('data-parallel'));
      expect(parallelFlags).toContain('true');
      // Sequenzielle Stufen (root, d) bleiben non-parallel.
      expect(parallelFlags.filter((f) => f === 'true')).toHaveLength(1);
      // b+c liegen in der Lane-Gruppe (eingerückte Spur-Achse).
      const lanes = h.container.querySelector('[data-test="flow-lanes"]');
      expect(lanes?.querySelectorAll('[data-test="flow-node"]')).toHaveLength(2);
    } finally {
      h.unmount();
    }
  });

  it('marks a join level (in-degree>1) with a join marker', () => {
    const h = mount({
      nodes: [
        { id: 'root', label: 'Start', status: 'done' },
        { id: 'b', label: 'B', status: 'done' },
        { id: 'c', label: 'C', status: 'done' },
        { id: 'd', label: 'Zusammenführen', status: 'idle' },
      ],
      edges: [
        { from: 'root', to: 'b' },
        { from: 'root', to: 'c' },
        { from: 'b', to: 'd' },
        { from: 'c', to: 'd' },
      ],
    });
    try {
      // d hat in-degree 2 → die Stufe von d trägt den Join-Marker.
      const join = h.container.querySelector('[data-test="flow-join-marker"]');
      expect(join).not.toBeNull();
      const dLevel = nodeById(h.container, 'd').closest('[data-test="flow-level"]');
      expect(dLevel?.getAttribute('data-join')).toBe('true');
      // root (in-degree 0) trägt keinen Join.
      const rootLevel = nodeById(h.container, 'root').closest('[data-test="flow-level"]');
      expect(rootLevel?.getAttribute('data-join')).toBe('false');
    } finally {
      h.unmount();
    }
  });

  it('a linear (sequential) flow has NO fork groups and NO join markers', () => {
    const h = mount({
      nodes: [
        { id: 'a', label: 'A', status: 'done' },
        { id: 'b', label: 'B', status: 'running' },
        { id: 'c', label: 'C', status: 'idle' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    });
    try {
      expect(
        h.container.querySelectorAll('[data-test="flow-fork-group"]'),
      ).toHaveLength(0);
      expect(
        h.container.querySelectorAll('[data-test="flow-join-marker"]'),
      ).toHaveLength(0);
      // Jede Stufe ist eine sequenzielle Stufe (ein Knoten).
      expect(
        h.container.querySelectorAll('[data-test="flow-seq-stage"]'),
      ).toHaveLength(3);
    } finally {
      h.unmount();
    }
  });
});

describe('flow-graph aktionierbare Knoten (W2.2 — EIN executeGateAction-Pfad)', () => {
  it('needs-input node → detail button clicks the SAME gate stream-card (no double submit)', () => {
    // Die echte Gate-Stream-Card (human-decision) muss im DOM existieren — der
    // executeGateAction-Pfad klickt IHREN primären Button. Genau wie der
    // ActionDeck-Pin. Wir bauen sie als Sibling neben den flow-graph.
    const gateCard = document.createElement('div');
    gateCard.setAttribute('data-test', 'surface-decision-brief');
    const gateBtn = document.createElement('button');
    gateBtn.setAttribute('data-test', 'decision-brief-option');
    gateBtn.setAttribute('data-recommended', 'true');
    let gateClicks = 0;
    gateBtn.addEventListener('click', () => {
      gateClicks += 1;
    });
    gateCard.appendChild(gateBtn);
    document.body.appendChild(gateCard);

    const h = mount({
      nodes: [
        {
          id: 'g',
          label: 'Experten-Freigabe',
          status: 'needs-input',
          gateKind: 'human-decision',
        },
      ],
      edges: [],
    });
    try {
      openNode(h.container, 'g');
      const actionBtn = h.container.querySelector<HTMLButtonElement>(
        '[data-test="flow-node-action"][data-action="gate"]',
      );
      expect(actionBtn).not.toBeNull();
      expect(actionBtn?.getAttribute('data-gate-kind')).toBe('human-decision');

      // EIN Tap → der echte Gate-Button wird GENAU EINMAL geklickt (single POST-
      // Pfad). Kein zweites fetch/Routing vom Knoten aus.
      act(() => {
        actionBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(gateClicks).toBe(1);
    } finally {
      h.unmount();
      gateCard.remove();
    }
  });

  it('needs-input node carries a visible badge and warn-accent class', () => {
    const h = mount({
      nodes: [
        { id: 'g', label: 'Freigabe', status: 'needs-input', gateKind: 'human-decision' },
      ],
      edges: [],
    });
    try {
      const node = nodeById(h.container, 'g');
      expect(node.getAttribute('data-status')).toBe('needs-input');
      expect(node.className).toContain('flow-graph-node--needs-input');
      expect(
        h.container.querySelector('[data-test="flow-node-badge-needs-input"]'),
      ).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('failed node → "Neu starten" calls reply with the verbatim step label', () => {
    const replySpy = vi.fn();
    const h = mount(
      {
        nodes: [{ id: 'x', label: 'Design-Schritt mit „Sonderzeichen"', status: 'failed' }],
        edges: [],
      },
      { reply: replySpy },
    );
    try {
      openNode(h.container, 'x');
      const btn = h.container.querySelector<HTMLButtonElement>(
        '[data-test="flow-node-action"][data-action="retry"]',
      );
      expect(btn).not.toBeNull();
      expect(btn?.textContent ?? '').toContain('Neu starten');
      act(() => {
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
      // N1: verbatim Label im Retry-Hinweis (kein .slice, Sonderzeichen erhalten).
      expect(replySpy.mock.calls[0]?.[0]).toContain('Design-Schritt mit „Sonderzeichen"');
    } finally {
      h.unmount();
    }
  });

  it('done node with previewUrl → "Vorschau öffnen" link (target=_blank)', () => {
    const h = mount({
      nodes: [
        {
          id: 'final',
          label: 'Website fertig',
          status: 'done',
          previewUrl: 'https://my-mac.ts.net/',
        },
      ],
      edges: [],
    });
    try {
      openNode(h.container, 'final');
      const link = h.container.querySelector<HTMLAnchorElement>(
        '[data-test="flow-node-action"][data-action="preview"]',
      );
      expect(link).not.toBeNull();
      expect(link?.getAttribute('href')).toBe('https://my-mac.ts.net/');
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.textContent ?? '').toContain('Vorschau öffnen');
    } finally {
      h.unmount();
    }
  });

  it('node without an allowed action shows NO button (purely informational)', () => {
    const h = mount({
      nodes: [
        { id: 'run', label: 'Läuft', status: 'running' },
        { id: 'idle', label: 'Wartet', status: 'idle' },
        { id: 'done', label: 'Fertig ohne URL', status: 'done' },
      ],
      edges: [
        { from: 'run', to: 'idle' },
        { from: 'idle', to: 'done' },
      ],
    });
    try {
      for (const id of ['run', 'idle', 'done']) {
        openNode(h.container, id);
        expect(
          h.container.querySelector('[data-test="flow-node-action"]'),
        ).toBeNull();
        // wieder schließen für den nächsten
        openNode(h.container, id);
      }
    } finally {
      h.unmount();
    }
  });
});

describe('flow-graph Anti-Proliferation (W2.2)', () => {
  it('suppresses the floating flow-graph card when a run-cockpit is active for the same coord', () => {
    const coord = { workspaceId: 'ws-x', workstreamId: 'WS-x' };
    const h = mount(
      {
        ...coord,
        title: 'Flow',
        nodes: [{ id: 'a', label: 'A', status: 'running' }],
        edges: [],
      },
      {
        withCockpit: {
          ...coord,
          phase: 'lead',
          phaseIndex: 1,
          phaseTotal: 6,
        },
      },
    );
    try {
      // run-cockpit ist gerendert, der freischwebende flow-graph supprimiert sich.
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).toBeNull();
      expect(nodes(h.container)).toHaveLength(0);
    } finally {
      h.unmount();
    }
  });

  it('renders the flow-graph normally when no run-cockpit is active (back-compat)', () => {
    const h = mount({
      workspaceId: 'ws-y',
      workstreamId: 'WS-y',
      title: 'Flow',
      nodes: [{ id: 'a', label: 'A', status: 'running' }],
      edges: [],
    });
    try {
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).not.toBeNull();
      expect(nodes(h.container)).toHaveLength(1);
    } finally {
      h.unmount();
    }
  });
});
