/**
 * Tests fuer Bug 1 — "Card verschwindet während Worker noch läuft".
 * ----------------------------------------------------------------
 * 2026-05-03. Der Per-Workstream-Cap (commit 88438b3) trimmt zu aggressiv:
 * Live-Activity-Cards (`<surface:agent>{"status":"läuft"}</surface>`,
 * `<surface:workflow-pipeline>{"state":"executing"}</surface>`) werden
 * gekillt obwohl ein Backend-Worker noch arbeitet.
 *
 * Fix: `enforceActiveCap` excluded Live-Cards (status/state/phase NICHT
 * in {done, closed, failed, aborted, ...}) vom Trim. Trimming wirkt nur
 * auf finalisierte Cards.
 *
 * Lauf:  pnpm exec vitest run lib/chat/__tests__/storage-cap-live-cards.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { HistoryItem } from '../ChatShell';
import { enforceActiveCap, isLiveActiveCard } from '../replace-logic';

const WS = '01J0000000000000000000000A';

function mkItem(partial: Partial<HistoryItem> & { id: string; ts: string }): HistoryItem {
  return {
    role: 'assistant',
    content: '',
    ...partial,
  } as HistoryItem;
}

function mkLive(
  id: string,
  ts: string,
  kind: string,
  payloadField: 'status' | 'state' | 'phase',
  value: string,
): HistoryItem {
  const payload = JSON.stringify({ workstreamId: WS, [payloadField]: value });
  return mkItem({
    id,
    ts,
    workstreamId: WS,
    surfaceKind: kind as HistoryItem['surfaceKind'],
    content: `<surface:${kind}>${payload}</surface:${kind}>`,
  });
}

function mkDone(id: string, ts: string, kind: string): HistoryItem {
  const payload = JSON.stringify({ workstreamId: WS, status: 'done' });
  return mkItem({
    id,
    ts,
    workstreamId: WS,
    surfaceKind: kind as HistoryItem['surfaceKind'],
    content: `<surface:${kind}>${payload}</surface:${kind}>`,
  });
}

// ---------------------------------------------------------------------------
// isLiveActiveCard — die Heuristik
// ---------------------------------------------------------------------------

describe('isLiveActiveCard', () => {
  it('agent mit status="läuft" ist live', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'agent', 'status', 'läuft');
    expect(isLiveActiveCard(it)).toBe(true);
  });

  it('agent mit status="done" ist NICHT live', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'agent', 'status', 'done');
    expect(isLiveActiveCard(it)).toBe(false);
  });

  it('workflow-pipeline mit state="executing" ist live', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'workflow-pipeline', 'state', 'executing');
    expect(isLiveActiveCard(it)).toBe(true);
  });

  it('workflow-pipeline mit state="running" ist live', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'workflow-pipeline', 'state', 'running');
    expect(isLiveActiveCard(it)).toBe(true);
  });

  it('workflow-pipeline mit state="closed" ist NICHT live', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'workflow-pipeline', 'state', 'closed');
    expect(isLiveActiveCard(it)).toBe(false);
  });

  it('Card ohne status/state/phase ist NICHT live (Default = trimbar)', () => {
    const it = mkItem({
      id: 'a',
      ts: '2026-05-03T10:00:00Z',
      workstreamId: WS,
      surfaceKind: 'workflow',
      content: `<surface:workflow>{"workstreamId":"${WS}"}</surface:workflow>`,
    });
    expect(isLiveActiveCard(it)).toBe(false);
  });

  it('Card mit failed/aborted/cancelled ist NICHT live', () => {
    expect(
      isLiveActiveCard(mkLive('a', '2026-05-03T10:00:00Z', 'agent', 'status', 'failed')),
    ).toBe(false);
    expect(
      isLiveActiveCard(mkLive('a', '2026-05-03T10:00:00Z', 'agent', 'status', 'aborted')),
    ).toBe(false);
    expect(
      isLiveActiveCard(mkLive('a', '2026-05-03T10:00:00Z', 'agent', 'status', 'cancelled')),
    ).toBe(false);
  });

  it('Item ohne surfaceKind ist NICHT live (= reine Plain-Bubble)', () => {
    const it = mkItem({ id: 'a', ts: '2026-05-03T10:00:00Z', content: 'hi' });
    expect(isLiveActiveCard(it)).toBe(false);
  });

  it('phase-Feld wird auch erkannt', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'workflow', 'phase', 'planning');
    expect(isLiveActiveCard(it)).toBe(true);
  });

  it('case-insensitive Terminal-States', () => {
    const it = mkLive('a', '2026-05-03T10:00:00Z', 'agent', 'status', 'DONE');
    expect(isLiveActiveCard(it)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// enforceActiveCap — Live-Cards bleiben, nur Done-Cards getrimmt
// ---------------------------------------------------------------------------

describe('enforceActiveCap mit Live-Cards', () => {
  it('Fixture aus User-Beschwerde: 5 done + 3 running, Cap=3, alle 3 running bleiben + 0 done', () => {
    // Eingabe: 5 finalisierte + 3 laufende Cards desselben Workstreams.
    const prev: HistoryItem[] = [
      mkDone('done-1', '2026-05-03T10:00:00Z', 'workflow'),
      mkDone('done-2', '2026-05-03T10:01:00Z', 'workflow'),
      mkDone('done-3', '2026-05-03T10:02:00Z', 'workflow'),
      mkDone('done-4', '2026-05-03T10:03:00Z', 'workflow'),
      mkDone('done-5', '2026-05-03T10:04:00Z', 'workflow'),
      mkLive('run-1', '2026-05-03T10:05:00Z', 'workflow', 'phase', 'planning'),
      mkLive('run-2', '2026-05-03T10:06:00Z', 'workflow-pipeline', 'state', 'executing'),
      mkLive('run-3', '2026-05-03T10:07:00Z', 'agent', 'status', 'läuft'),
    ];
    // Naechste Card (auch live).
    const incoming = mkLive(
      'incoming',
      '2026-05-03T10:08:00Z',
      'workflow',
      'phase',
      'roast',
    );

    const res = enforceActiveCap(prev, incoming, 3);

    // Alle 3 laufenden Cards muessen ueberleben.
    for (const id of ['run-1', 'run-2', 'run-3']) {
      const found = res.find((i) => i.id === id);
      expect(found).toBeDefined();
      expect(found?.archived).toBeFalsy();
    }
    // Mindestens so viele Done-Cards archivieren wie moeglich.
    // active.length=8, cap=3, overflow=8+1-3=6, trimmable=5 done.
    // -> alle 5 done werden archiviert.
    for (const id of ['done-1', 'done-2', 'done-3', 'done-4', 'done-5']) {
      const found = res.find((i) => i.id === id);
      expect(found?.archived).toBe(true);
    }
  });

  it('Live-Cards werden NIE archiviert, auch wenn dadurch Cap ueberschritten wird', () => {
    // 4 laufende Cards + 1 done. Cap=3.
    const prev: HistoryItem[] = [
      mkDone('done-old', '2026-05-03T10:00:00Z', 'workflow'),
      mkLive('run-1', '2026-05-03T10:01:00Z', 'agent', 'status', 'läuft'),
      mkLive('run-2', '2026-05-03T10:02:00Z', 'agent', 'status', 'läuft'),
      mkLive('run-3', '2026-05-03T10:03:00Z', 'agent', 'status', 'läuft'),
      mkLive('run-4', '2026-05-03T10:04:00Z', 'agent', 'status', 'läuft'),
    ];
    const incoming = mkLive(
      'incoming',
      '2026-05-03T10:05:00Z',
      'agent',
      'status',
      'läuft',
    );

    const res = enforceActiveCap(prev, incoming, 3);

    // run-1..run-4 alle live.
    for (const id of ['run-1', 'run-2', 'run-3', 'run-4']) {
      expect(res.find((i) => i.id === id)?.archived).toBeFalsy();
    }
    // done-old wird archiviert (einzige trimmbare Card).
    expect(res.find((i) => i.id === 'done-old')?.archived).toBe(true);
  });

  it('Wenn ALLE active-Cards live sind, gibt enforceActiveCap prev unveraendert zurueck', () => {
    const prev: HistoryItem[] = [
      mkLive('run-1', '2026-05-03T10:01:00Z', 'agent', 'status', 'läuft'),
      mkLive('run-2', '2026-05-03T10:02:00Z', 'agent', 'status', 'läuft'),
      mkLive('run-3', '2026-05-03T10:03:00Z', 'agent', 'status', 'läuft'),
      mkLive('run-4', '2026-05-03T10:04:00Z', 'agent', 'status', 'läuft'),
    ];
    const incoming = mkLive(
      'incoming',
      '2026-05-03T10:05:00Z',
      'agent',
      'status',
      'läuft',
    );

    const res = enforceActiveCap(prev, incoming, 3);
    expect(res).toBe(prev); // Identity — nichts zu tun.
  });

  it('Done-Cards werden weiterhin nach TS aufsteigend (aelteste zuerst) getrimmt', () => {
    const prev: HistoryItem[] = [
      mkDone('done-newest', '2026-05-03T10:05:00Z', 'workflow'),
      mkDone('done-mid', '2026-05-03T10:03:00Z', 'workflow'),
      mkDone('done-oldest', '2026-05-03T10:01:00Z', 'workflow'),
    ];
    const incoming = mkDone('incoming', '2026-05-03T10:06:00Z', 'workflow');

    // 3 done + 1 incoming = 4, Cap=3 → 1 archivieren (aelteste).
    const res = enforceActiveCap(prev, incoming, 3);
    expect(res.find((i) => i.id === 'done-oldest')?.archived).toBe(true);
    expect(res.find((i) => i.id === 'done-mid')?.archived).toBeFalsy();
    expect(res.find((i) => i.id === 'done-newest')?.archived).toBeFalsy();
  });

  it('Cards in anderen Workstreams werden vom Cap nicht beruehrt', () => {
    const wsOther = '01J0000000000000000000000B';
    const prev: HistoryItem[] = [
      // Andere Workstream-ID, irrelevant fuer den Cap.
      mkItem({
        id: 'other-1',
        ts: '2026-05-03T10:00:00Z',
        workstreamId: wsOther,
        surfaceKind: 'workflow',
        content: `<surface:workflow>{"workstreamId":"${wsOther}","status":"done"}</surface:workflow>`,
      }),
      mkDone('done-1', '2026-05-03T10:01:00Z', 'workflow'),
      mkDone('done-2', '2026-05-03T10:02:00Z', 'workflow'),
      mkDone('done-3', '2026-05-03T10:03:00Z', 'workflow'),
    ];
    const incoming = mkDone('incoming', '2026-05-03T10:04:00Z', 'workflow');
    const res = enforceActiveCap(prev, incoming, 3);
    expect(res.find((i) => i.id === 'other-1')?.archived).toBeFalsy();
    expect(res.find((i) => i.id === 'done-1')?.archived).toBe(true);
  });
});
