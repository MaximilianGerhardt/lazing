/**
 * flow-graph Surface Tests · Flow Studio P3 (2026-05-27).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/flow-graph-surface.test.tsx
 *
 * Cases:
 *   1. Render: N Nodes + Labels sichtbar; runStatus-Pill vorhanden.
 *   2. Status-Dots: jede Node traegt data-status; Farben je status korrekt.
 *   3. Skill/Tool: Mono-Skill-Label + Tool-Badge sichtbar.
 *   4. Dangling edge (from/to nicht in nodes) wird ignoriert (kein Throw).
 *   5. Leere nodes → null (nichts gerendert, kein Throw).
 *   6. Fehlende nodes-Property → null.
 *   7. Unbekannter Node-Status → idle (Fallback).
 *   8. Topologie: Level-Zuweisung (Root=0, Kind=1) via data-level.
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
      <SurfaceActionProvider
        reply={() => undefined}
        pushAssistant={() => undefined}
      >
        {renderSurface('flow-graph', data)}
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

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('flow-graph surface', () => {
  it('renders N nodes with labels and a runStatus pill', () => {
    const h = mount({
      title: 'Onboarding-Flow',
      runStatus: 'running',
      nodes: [
        { id: 'a', label: 'Intake', status: 'done' },
        { id: 'b', label: 'Plan', status: 'running' },
        { id: 'c', label: 'Dispatch', status: 'idle' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    });
    try {
      expect(nodes(h.container)).toHaveLength(3);
      const text = h.container.textContent ?? '';
      expect(text).toContain('Intake');
      expect(text).toContain('Plan');
      expect(text).toContain('Dispatch');
      expect(text).toContain('Onboarding-Flow');

      // runStatus-Pill sichtbar mit korrektem Status-Attribut + Label.
      const pill = h.container.querySelector<HTMLElement>(
        '[data-test="flow-run-status"]',
      );
      expect(pill).not.toBeNull();
      expect(pill?.getAttribute('data-run-status')).toBe('running');
      expect(pill?.textContent ?? '').toContain('Läuft');
    } finally {
      h.unmount();
    }
  });

  it('applies the right status-dot color per node status', () => {
    const h = mount({
      nodes: [
        { id: 'i', label: 'Idle', status: 'idle' },
        { id: 'r', label: 'Running', status: 'running' },
        { id: 'd', label: 'Done', status: 'done' },
        { id: 'n', label: 'Needs', status: 'needs-input' },
        { id: 'f', label: 'Failed', status: 'failed' },
      ],
      edges: [],
    });
    try {
      const dotFor = (status: string): HTMLElement => {
        const el = h.container.querySelector<HTMLElement>(
          `[data-test="flow-node-dot"][data-status="${status}"]`,
        );
        if (!el) throw new Error(`no dot for status ${status}`);
        return el;
      };

      // Token-bind Farben (var(--token, #fallback)). Wir pruefen sie ueber das
      // data-dot-color-Attribut — happy-dom verschluckt color-Properties mit
      // var()-Fallback beim style-Serialisieren (im Browser rendern sie korrekt).
      expect(dotFor('idle').getAttribute('data-dot-color')).toContain('--ink-3');
      expect(dotFor('running').getAttribute('data-dot-color')).toContain('--a-now');
      expect(dotFor('done').getAttribute('data-dot-color')).toContain('--a-ok');
      expect(dotFor('needs-input').getAttribute('data-dot-color')).toContain('--a-warn');
      expect(dotFor('failed').getAttribute('data-dot-color')).toContain('--a-danger');

      // running pulsiert (reuse @keyframes pulse), andere nicht. Der
      // animation-Shorthand round-trippt in happy-dom (anders als color+var()).
      expect(dotFor('running').getAttribute('style') ?? '').toContain('pulse');
      expect(dotFor('idle').getAttribute('style') ?? '').not.toContain('pulse');

      // Jede Node traegt data-status auf der Card.
      const statuses = nodes(h.container).map((n) => n.getAttribute('data-status'));
      expect(statuses).toEqual(['idle', 'running', 'done', 'needs-input', 'failed']);
    } finally {
      h.unmount();
    }
  });

  it('renders skill mono-label and tool badge', () => {
    const h = mount({
      nodes: [
        { id: 'a', label: 'Research', skill: 'lazing-researcher', tool: 'WebSearch' },
      ],
      edges: [],
    });
    try {
      const skill = h.container.querySelector<HTMLElement>(
        '[data-test="flow-node-skill"]',
      );
      const tool = h.container.querySelector<HTMLElement>(
        '[data-test="flow-node-tool"]',
      );
      expect(skill?.textContent).toBe('lazing-researcher');
      expect(tool?.textContent).toBe('WebSearch');
    } finally {
      h.unmount();
    }
  });

  it('ignores dangling edges (from/to not in nodes) without throwing', () => {
    const h = mount({
      nodes: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      edges: [
        { from: 'a', to: 'b' }, // valid
        { from: 'a', to: 'ghost' }, // dangling target
        { from: 'phantom', to: 'b' }, // dangling source
      ],
    });
    try {
      // Nur die EINE valide Edge wird gezeichnet.
      const edgeEls = h.container.querySelectorAll('[data-test="flow-edge"]');
      expect(edgeEls).toHaveLength(1);
      const onlyEdge = edgeEls[0] as HTMLElement;
      expect(onlyEdge.getAttribute('data-edge-from')).toBe('a');
      expect(onlyEdge.getAttribute('data-edge-to')).toBe('b');
      // Beide Nodes weiterhin gerendert.
      expect(nodes(h.container)).toHaveLength(2);
    } finally {
      h.unmount();
    }
  });

  it('renders nothing for empty nodes (no throw)', () => {
    const h = mount({ title: 'Leer', nodes: [], edges: [] });
    try {
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).toBeNull();
      expect(nodes(h.container)).toHaveLength(0);
    } finally {
      h.unmount();
    }
  });

  it('renders nothing when nodes property is missing (no throw)', () => {
    const h = mount({ title: 'Kein Feld' });
    try {
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('falls back to idle for an unknown node status', () => {
    const h = mount({
      nodes: [{ id: 'x', label: 'Mystery', status: 'banana' }],
      edges: [],
    });
    try {
      const node = nodes(h.container)[0];
      expect(node.getAttribute('data-status')).toBe('idle');
    } finally {
      h.unmount();
    }
  });

  it('assigns topological levels (root=0, child=1)', () => {
    const h = mount({
      nodes: [
        { id: 'root', label: 'Root' },
        { id: 'child', label: 'Child' },
      ],
      edges: [{ from: 'root', to: 'child' }],
    });
    try {
      const levels = Array.from(
        h.container.querySelectorAll<HTMLElement>('[data-test="flow-level"]'),
      ).map((el) => el.getAttribute('data-level'));
      // Zwei Ebenen: 0 (root) und 1 (child).
      expect(levels).toEqual(['0', '1']);
    } finally {
      h.unmount();
    }
  });

  it('defaults runStatus to idle when omitted or invalid', () => {
    const h = mount({
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
      runStatus: 'bogus',
    });
    try {
      const pill = h.container.querySelector<HTMLElement>(
        '[data-test="flow-run-status"]',
      );
      expect(pill?.getAttribute('data-run-status')).toBe('idle');
      expect(pill?.textContent ?? '').toContain('Bereit');
    } finally {
      h.unmount();
    }
  });

  // P-now (2026-05-27): Nodes sind tappbar → Detail-Panel.
  it('shows a node detail panel on tap and toggles it off on re-tap', () => {
    const h = mount({
      nodes: [
        {
          id: 'r',
          label: 'Research',
          skill: 'lazing-researcher',
          tool: 'WebSearch',
          status: 'running',
        },
      ],
      edges: [],
    });
    try {
      // Vor dem Tap: kein Detail-Panel.
      expect(
        h.container.querySelector('[data-test="flow-node-detail"]'),
      ).toBeNull();

      const node = nodes(h.container)[0];
      expect(node.getAttribute('data-open')).toBe('false');

      // Tap → Detail sichtbar mit label, skill, tool, status.
      act(() => {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const detail = h.container.querySelector<HTMLElement>(
        '[data-test="flow-node-detail"]',
      );
      expect(detail).not.toBeNull();
      expect(detail?.getAttribute('data-node-id')).toBe('r');
      expect(
        h.container.querySelector('[data-test="flow-node-detail-label"]')
          ?.textContent,
      ).toBe('Research');
      expect(
        h.container.querySelector('[data-test="flow-node-detail-skill"]')
          ?.textContent,
      ).toContain('lazing-researcher');
      expect(
        h.container.querySelector('[data-test="flow-node-detail-tool"]')
          ?.textContent,
      ).toContain('WebSearch');
      const statusEl = h.container.querySelector<HTMLElement>(
        '[data-test="flow-node-detail-status"]',
      );
      expect(statusEl?.getAttribute('data-status')).toBe('running');
      expect(nodes(h.container)[0].getAttribute('data-open')).toBe('true');

      // Re-Tap → Detail wieder zu.
      act(() => {
        nodes(h.container)[0].dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
      expect(
        h.container.querySelector('[data-test="flow-node-detail"]'),
      ).toBeNull();
    } finally {
      h.unmount();
    }
  });

  // P-now: ein Node, der auf ein ungekoppeltes Tool zeigt, bekommt im Detail
  // einen „koppeln"-Hinweis.
  it('shows a coupling hint in the detail when needsCoupling is set', () => {
    const h = mount({
      nodes: [
        { id: 'x', label: 'Mail senden', needsCoupling: true, status: 'needs-input' },
      ],
      edges: [],
    });
    try {
      act(() => {
        nodes(h.container)[0].dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        );
      });
      const hint = h.container.querySelector<HTMLElement>(
        '[data-test="flow-node-detail-coupling-hint"]',
      );
      expect(hint).not.toBeNull();
      expect(hint?.textContent ?? '').toContain('koppeln');
    } finally {
      h.unmount();
    }
  });

  // -------------------------------------------------------------------------
  // Stream C · C2 (2026-05-27): collapse/expand-Toggle.
  // Owner-SOLL: „muss nicht dauerhaft sein, aber klickbar → oeffnet die Surface".
  // -------------------------------------------------------------------------

  it('starts collapsed (chip only) when collapsed:true and expands on tap', () => {
    const h = mount({
      title: 'Onboarding-Flow',
      collapsed: true,
      nodes: [
        { id: 'a', label: 'Intake', status: 'done' },
        { id: 'b', label: 'Plan', status: 'running' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    });
    try {
      // Eingeklappt: nur der Chip, KEINE volle Surface, KEINE Nodes.
      const chip = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-collapsed-chip"]',
      );
      expect(chip).not.toBeNull();
      expect(chip?.textContent ?? '').toContain('Prozess ansehen');
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).toBeNull();
      expect(nodes(h.container)).toHaveLength(0);

      // Tap auf den Chip → volle Surface, Nodes sichtbar.
      act(() => {
        chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).not.toBeNull();
      expect(nodes(h.container)).toHaveLength(2);
    } finally {
      h.unmount();
    }
  });

  it('renders expanded by default (no collapsed flag) and can collapse via the action', () => {
    const h = mount({
      title: 'Flow',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
    });
    try {
      // Default = expandiert sofort.
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).not.toBeNull();

      // „Einklappen" → zurueck zum Chip.
      const collapseBtn = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-collapse"]',
      );
      expect(collapseBtn).not.toBeNull();
      act(() => {
        collapseBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(
        h.container.querySelector('[data-test="surface-flow-graph"]'),
      ).toBeNull();
      expect(
        h.container.querySelector('[data-test="flow-graph-collapsed-chip"]'),
      ).not.toBeNull();
    } finally {
      h.unmount();
    }
  });

  // -------------------------------------------------------------------------
  // Stream C · C3 (2026-05-27): „Als Prozess speichern" → POST
  // /api/flow/from-workstream (optimistic, fail-soft). fetch gemockt.
  // -------------------------------------------------------------------------

  it('hides the save-process button when workstreamId/workspaceId are absent', () => {
    const h = mount({
      title: 'Flow',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
    });
    try {
      expect(
        h.container.querySelector('[data-test="flow-graph-save-process"]'),
      ).toBeNull();
    } finally {
      h.unmount();
    }
  });

  it('POSTs to /api/flow/from-workstream on "Als Prozess speichern" and shows saved state', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const h = mount({
      title: 'Mein Prozess',
      workstreamId: 'WS-c3',
      workspaceId: 'ws-c3',
      nodes: [{ id: 'a', label: 'A', status: 'done' }],
      edges: [],
    });
    try {
      const btn = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-save-process"]',
      );
      expect(btn).not.toBeNull();
      expect(btn?.textContent ?? '').toContain('Als Prozess speichern');

      await act(async () => {
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        // Microtask-Tick, damit die await fetch-Kette durchläuft.
        await Promise.resolve();
        await Promise.resolve();
      });

      // fetch korrekt aufgerufen.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/flow/from-workstream');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body.workstreamId).toBe('WS-c3');
      expect(body.workspaceId).toBe('ws-c3');
      expect(body.name).toBe('Mein Prozess'); // title als name (N1)

      // saved-State sichtbar.
      const after = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-save-process"]',
      );
      expect(after?.getAttribute('data-save-state')).toBe('saved');
      expect(after?.textContent ?? '').toContain('gespeichert');
    } finally {
      h.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('fail-soft: a non-2xx response sets error state, not a crash', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const h = mount({
      title: 'Flow',
      workstreamId: 'WS-c3',
      workspaceId: 'ws-c3',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
    });
    try {
      const btn = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-save-process"]',
      );
      await act(async () => {
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      const after = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-save-process"]',
      );
      expect(after?.getAttribute('data-save-state')).toBe('error');
      expect(after?.textContent ?? '').toContain('Erneut speichern');
    } finally {
      h.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('fail-soft: a rejected fetch (network error) sets error state, not a crash', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const h = mount({
      title: 'Flow',
      workstreamId: 'WS-c3',
      workspaceId: 'ws-c3',
      nodes: [{ id: 'a', label: 'A' }],
      edges: [],
    });
    try {
      const btn = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-save-process"]',
      );
      await act(async () => {
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();
      });
      const after = h.container.querySelector<HTMLElement>(
        '[data-test="flow-graph-save-process"]',
      );
      expect(after?.getAttribute('data-save-state')).toBe('error');
    } finally {
      h.unmount();
      vi.unstubAllGlobals();
    }
  });
});
