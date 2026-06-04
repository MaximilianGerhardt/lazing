/**
 * lib/workstreams/__tests__/flow-graph-structure-emit.test.ts
 * -----------------------------------------------------------
 * Flow Studio Stream C · C1 (2026-05-27).
 *
 * BEFUND: die <surface:flow-graph>-Emission im plan-executor feuerte bei jedem
 * updateCard — also nur an Step-STATUS-Übergänge gekoppelt. Owner-SOLL: "immer
 * auch visualisieren wenn sich was ändert/erweitert" — also AUCH bei STRUKTUR-
 * Änderungen (neue Steps, geänderte depends_on/Edges, geänderte Tools).
 *
 * Diese Tests decken den C1-Kern ab (REINE Funktionen, kein executePlan-Run):
 *   - computeFlowStructureHash: erkennt Step/Edge/Tool-Änderung als verschiedenen
 *     Hash; eine reine Status-Wiederholung verändert den Hash NICHT (Status ist
 *     nicht Teil des Struktur-Hash).
 *   - shouldEmitFlowGraph: emittiert bei Struktur-Änderung ODER runStatus-Wechsel
 *     neu; bei reiner Status-Wiederholung (gleiche Struktur + gleicher runStatus)
 *     NICHT.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/workstreams/__tests__/flow-graph-structure-emit.test.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  computeFlowStructureHash,
  shouldEmitFlowGraph,
  __resetFlowGraphEmitCacheForTests,
} from '@/lib/workstreams/plan-executor';

type Node = { id: string; label: string; skill?: string; tool?: string };
type Edge = { from: string; to: string };

beforeEach(() => {
  __resetFlowGraphEmitCacheForTests();
});

describe('computeFlowStructureHash (C1 — struct-only, status-free)', () => {
  it('is stable for identical structure regardless of node order', () => {
    const a: Node[] = [
      { id: 's1', label: 'Intake' },
      { id: 's2', label: 'Plan' },
    ];
    const aReordered: Node[] = [
      { id: 's2', label: 'Plan' },
      { id: 's1', label: 'Intake' },
    ];
    const edges: Edge[] = [{ from: 's1', to: 's2' }];
    expect(computeFlowStructureHash(a, edges)).toBe(
      computeFlowStructureHash(aReordered, edges),
    );
  });

  it('changes when a new step (node) is added', () => {
    const before: Node[] = [{ id: 's1', label: 'Intake' }];
    const after: Node[] = [
      { id: 's1', label: 'Intake' },
      { id: 's2', label: 'Plan' },
    ];
    expect(computeFlowStructureHash(before, [])).not.toBe(
      computeFlowStructureHash(after, []),
    );
  });

  it('changes when an edge (depends_on) is added/changed', () => {
    const nodes: Node[] = [
      { id: 's1', label: 'A' },
      { id: 's2', label: 'B' },
    ];
    const noEdge = computeFlowStructureHash(nodes, []);
    const withEdge = computeFlowStructureHash(nodes, [{ from: 's1', to: 's2' }]);
    expect(noEdge).not.toBe(withEdge);
  });

  it("changes when a step's tool changes", () => {
    const nodes1: Node[] = [{ id: 's1', label: 'Render', tool: 'connector' }];
    const nodes2: Node[] = [{ id: 's1', label: 'Render', tool: 'mcp' }];
    expect(computeFlowStructureHash(nodes1, [])).not.toBe(
      computeFlowStructureHash(nodes2, []),
    );
  });

  it("changes when a step's skill changes", () => {
    const nodes1: Node[] = [{ id: 's1', label: 'Build', skill: 'coder' }];
    const nodes2: Node[] = [{ id: 's1', label: 'Build', skill: 'architect' }];
    expect(computeFlowStructureHash(nodes1, [])).not.toBe(
      computeFlowStructureHash(nodes2, []),
    );
  });
});

describe('shouldEmitFlowGraph (C1 — emit gating)', () => {
  const KEY = 'ws-c1/WS-c1';

  it('emits on first call (no prior state)', () => {
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(true);
  });

  it('does NOT re-emit on a pure status repeat (same struct + same runStatus)', () => {
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(true);
    // identische Struktur + identischer runStatus → KEIN redundanter Emit.
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(false);
  });

  it('re-emits when the structure hash changes (new step/edge/tool)', () => {
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(true);
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(false);
    // Struktur-Erweiterung → ZWINGEND neue Visualisierung, auch bei gleichem Status.
    expect(shouldEmitFlowGraph(KEY, 'hashB', 'running')).toBe(true);
  });

  it('re-emits when only the runStatus changes (status transition)', () => {
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'idle')).toBe(true);
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(true);
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(false);
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'done')).toBe(true);
  });

  it('tracks separate state per cache key (per workspace/workstream)', () => {
    expect(shouldEmitFlowGraph('ws-a/WS-a', 'h', 'running')).toBe(true);
    // anderer Key → eigener State → erster Emit ist true (kein Cross-Talk).
    expect(shouldEmitFlowGraph('ws-b/WS-b', 'h', 'running')).toBe(true);
    expect(shouldEmitFlowGraph('ws-a/WS-a', 'h', 'running')).toBe(false);
  });

  it('the cache reset helper clears all state', () => {
    expect(shouldEmitFlowGraph(KEY, 'h', 'running')).toBe(true);
    expect(shouldEmitFlowGraph(KEY, 'h', 'running')).toBe(false);
    __resetFlowGraphEmitCacheForTests();
    // nach reset wieder erster-Emit-Verhalten.
    expect(shouldEmitFlowGraph(KEY, 'h', 'running')).toBe(true);
  });

  // W2.2 (2026-05-30): ein Wechsel in/aus `needs-input` ändert den FlowRunStatus
  // NICHT (Run läuft weiter), wird aber als veränderter Emit-Schlüssel
  // (`running#ni:<ids>`) gefaltet → ZWINGEND re-emit, damit der Owner den gerade
  // aufgegangenen, aktionierbaren Gate-Node sieht.
  it('re-emits when a node enters/leaves needs-input although runStatus is unchanged', () => {
    // gleiche Struktur, runStatus bleibt 'running'.
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(true);
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(false);
    // Ein Step geht in needs-input → der emitKey enthält jetzt die ni-Signatur.
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running#ni:s2')).toBe(true);
    // gleiche needs-input-Signatur wiederholt → kein redundanter Emit.
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running#ni:s2')).toBe(false);
    // Gate freigegeben → needs-input weg → zurück zu plain 'running' → re-emit.
    expect(shouldEmitFlowGraph(KEY, 'hashA', 'running')).toBe(true);
  });
});
