/**
 * Tests fuer Cluster A+B (Sub-Plan 3, 2026-05-01).
 *
 * Smoke-Tests gegen den SurfaceRenderer fuer den neuen workflow-Cluster-
 * Kind. Stellt sicher dass:
 *   - Renderer erkennt `<surface:workflow>` mit allen phase-Varianten
 *   - Phase-Transitionen werden ueber die Replace-Logik abgewickelt
 *     (kein neues History-Item, sondern Patch via archiveStalePeers)
 *   - Iterate-Family (Cluster B) wird in workflow.phase=iterate
 *     integriert: alte iterate-roast/iterate-version-Tags routen via
 *     Cluster-Mapping auf den workflow-Slot
 */

import { describe, expect, it } from 'vitest';

import type { HistoryItem } from '../ChatShell';
import { archiveStalePeers, canonicalKind } from '../replace-logic';
import { renderSurface } from '../SurfaceRenderer';

const WS_A = '01J0000000000000000000000A';

function mkItem(partial: Partial<HistoryItem> & { id: string; ts: string }): HistoryItem {
  return {
    role: 'assistant',
    content: '',
    ...partial,
  } as HistoryItem;
}

describe('Cluster A · workflow-Renderer', () => {
  it('phase=intake mit steps[] rendert Pipeline-Fallback', () => {
    const out = renderSurface('workflow', {
      phase: 'intake',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      steps: [
        { num: 1, title: 'Brief sammeln', status: 'done' },
        { num: 2, title: 'Plan erstellen', status: 'running' },
      ],
    });
    expect(out).toBeTruthy();
  });

  it('phase=execute mit subTickets rendert LivePipeline', () => {
    const out = renderSurface('workflow', {
      phase: 'execute',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      masterTicketId: 'TCK-1',
      subTickets: [
        { id: 'TCK-2', title: 'Sub 1' },
        { id: 'TCK-3', title: 'Sub 2' },
      ],
    });
    expect(out).toBeTruthy();
  });

  it('phase=iterate routes auf IteratePipelineCard', () => {
    const out = renderSurface('workflow', {
      phase: 'iterate',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
      maxVersion: 5,
    });
    expect(out).toBeTruthy();
  });

  it('phase=done ohne steps rendert generischen Fallback', () => {
    const out = renderSurface('workflow', {
      phase: 'done',
      workspaceId: 'ws-1',
    });
    expect(out).toBeTruthy();
  });

  it('unbekannte phase faellt sauber auf execute zurueck', () => {
    const out = renderSurface('workflow', {
      phase: 'totally-fake-phase',
      workstreamId: WS_A,
      workspaceId: 'ws-1',
    });
    expect(out).toBeTruthy();
  });
});

describe('Cluster B · Iterate-Family in workflow.phase=iterate integriert', () => {
  it('iterate-roast mappt auf workflow-Cluster (canonicalKind)', () => {
    expect(canonicalKind('iterate-roast')).toBe('workflow');
    expect(canonicalKind('iterate-version')).toBe('workflow');
    expect(canonicalKind('user-correction')).toBe('workflow');
  });

  it('Phase-Transition rendert KEIN neues History-Item sondern archiviert das alte', () => {
    // Simulation: workflow phase=plan kommt zuerst, dann phase=iterate.
    // Replace-Logik erkennt selben Workstream-Slot und archiviert die
    // alte Card. Frontend zeigt nur die neueste — semantisch ein "Patch".
    const prev: HistoryItem[] = [
      mkItem({
        id: 'plan-card',
        ts: '2026-05-01T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'workflow',
      }),
    ];
    const incoming = mkItem({
      id: 'iterate-card',
      ts: '2026-05-01T10:01:00Z',
      workstreamId: WS_A,
      surfaceKind: 'workflow',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBe(true);
    expect(res.incoming.archived).toBeFalsy();
    // Wichtig: das incoming bleibt EIN Item — kein zusaetzliches.
    expect(res.prev.length).toBe(1);
  });

  it('alte iterate-roast-Card wird durch neue workflow-Card ersetzt', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old-roast',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'iterate-roast',
      }),
    ];
    const incoming = mkItem({
      id: 'new-workflow',
      ts: '2026-05-01T10:00:00Z',
      workstreamId: WS_A,
      surfaceKind: 'workflow',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBe(true);
  });
});
