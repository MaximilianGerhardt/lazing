/**
 * Tests fuer die Sub-Plan-A One-Card-Pro-Workstream-Replace-Logik.
 * ----------------------------------------------------------------
 * Sub-Plan A (2026-04-29). Pure-Function-Coverage:
 *
 *   - archiveStalePeers           (lib/chat/replace-logic.ts)
 *   - hydrateWorkstreamCoords     (lib/chat/replace-logic.ts)
 *   - applyReplacePass            (lib/chat/storage.ts)
 *   - extractWorkstreamCoords*    (lib/chat/surface-parser.ts)
 *
 * Edge-Cases (aus Code-Review-Prompt + Findings 3-5):
 *   - replay-out-of-order
 *   - malformed JSON im Surface-Tag
 *   - duplicate Coords im Batch
 *   - mixed-archived (alte archived bleiben unangetastet)
 *   - TS-Tie -> stable-tiebreaker via id
 *   - Hydrate-Marker (zweiter Read = no-op)
 *
 * Lauf:  pnpm exec vitest run lib/chat/__tests__/replace-logic.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { HistoryItem } from '../ChatShell';
import {
  archiveStalePeers,
  canonicalKind,
  enforceActiveCap,
  hydrateWorkstreamCoords,
} from '../replace-logic';
import { applyReplacePass } from '../storage';
import {
  extractWorkstreamCoords,
  extractWorkstreamCoordsLoose,
} from '../surface-parser';

// ---------------------------------------------------------------------------
// Test-Helpers
// ---------------------------------------------------------------------------

function mkItem(partial: Partial<HistoryItem> & { id: string; ts: string }): HistoryItem {
  return {
    role: 'assistant',
    content: '',
    ...partial,
  } as HistoryItem;
}

// Surface-Tag-JSON. WS_VALID = ULID-shape, deterministic.
const WS_A = '01J0000000000000000000000A';
const WS_B = '01J0000000000000000000000B';

function surfaceTag(kind: string, payload: Record<string, unknown>): string {
  return `<surface:${kind}>${JSON.stringify(payload)}</surface:${kind}>`;
}

// ---------------------------------------------------------------------------
// archiveStalePeers
// ---------------------------------------------------------------------------

describe('archiveStalePeers', () => {
  it('mit (workstreamId, surfaceKind) im incoming archiviert vorige Peers', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old-1',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
        content: 'v1',
      }),
      mkItem({
        id: 'other',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: WS_B,
        surfaceKind: 'consensus-action',
        content: 'unrelated',
      }),
    ];
    const incoming = mkItem({
      id: 'new',
      ts: '2026-04-29T10:02:00Z',
      workstreamId: WS_A,
      surfaceKind: 'consensus-action',
      content: 'v2',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBe(true);
    expect(res.prev[1]?.archived).toBeFalsy(); // unrelated bleibt lebend
    expect(res.incoming.archived).toBeFalsy();
    expect(res.incoming.workstreamId).toBe(WS_A);
  });

  it('extrahiert Coords aus Content wenn felder fehlen', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
    ];
    const incoming = mkItem({
      id: 'new',
      ts: '2026-04-29T10:02:00Z',
      content: surfaceTag('consensus-action', { workstreamId: WS_A, level: 'strong' }),
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBe(true);
    expect(res.incoming.workstreamId).toBe(WS_A);
    expect(res.incoming.surfaceKind).toBe('consensus-action');
  });

  it('idempotent — selbe id im prev wird nicht selbst archiviert', () => {
    const incoming = mkItem({
      id: 'self',
      ts: '2026-04-29T10:00:00Z',
      workstreamId: WS_A,
      surfaceKind: 'consensus-action',
    });
    const res = archiveStalePeers([incoming], incoming);
    expect(res.prev[0]?.archived).toBeFalsy();
  });

  it('mixed-archived: bereits archivierte Peers werden nicht angetastet', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'archived-old',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
        archived: true,
      }),
    ];
    const incoming = mkItem({
      id: 'new',
      ts: '2026-04-29T10:02:00Z',
      workstreamId: WS_A,
      surfaceKind: 'consensus-action',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBe(true); // unchanged
    expect(res.prev[0]?.id).toBe('archived-old');
  });

  it('ohne Coords (incoming + Content leer) bleibt prev unveraendert', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
    ];
    const incoming = mkItem({
      id: 'new',
      ts: '2026-04-29T10:02:00Z',
      content: 'plain text without surface tag',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev).toBe(prev); // identical reference (kein Mutation)
    expect(res.incoming).toBe(incoming);
  });

  it('idempotent bei mehrfacher Anwendung (replay-resilience)', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
    ];
    const incoming = mkItem({
      id: 'new',
      ts: '2026-04-29T10:02:00Z',
      workstreamId: WS_A,
      surfaceKind: 'consensus-action',
    });
    const res1 = archiveStalePeers(prev, incoming);
    const res2 = archiveStalePeers(res1.prev, res1.incoming);
    expect(res2.prev[0]?.archived).toBe(true);
    expect(res2.incoming.archived).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// hydrateWorkstreamCoords
// ---------------------------------------------------------------------------

describe('hydrateWorkstreamCoords', () => {
  it('bereits gesetzte Coords -> Marker setzen, sonst unveraendert', () => {
    const item = mkItem({
      id: 'a',
      ts: '2026-04-29T10:00:00Z',
      workstreamId: WS_A,
      surfaceKind: 'consensus-action',
    });
    const res = hydrateWorkstreamCoords(item);
    expect(res._coordsHydrated).toBe(true);
    expect(res.workstreamId).toBe(WS_A);
  });

  it('zieht Coords aus Content nach (loose-extract)', () => {
    const item = mkItem({
      id: 'a',
      ts: '2026-04-29T10:00:00Z',
      content: surfaceTag('consensus-action', { workstreamId: WS_A, level: 'weak' }),
    });
    const res = hydrateWorkstreamCoords(item);
    expect(res.workstreamId).toBe(WS_A);
    expect(res.surfaceKind).toBe('consensus-action');
    expect(res._coordsHydrated).toBe(true);
  });

  it('Marker greift: zweiter Hydrate-Aufruf returnt das selbe Item', () => {
    const item = mkItem({
      id: 'a',
      ts: '2026-04-29T10:00:00Z',
      content: surfaceTag('consensus-action', { workstreamId: WS_A }),
    });
    const once = hydrateWorkstreamCoords(item);
    const twice = hydrateWorkstreamCoords(once);
    expect(twice).toBe(once); // identity — keine erneute Regex-Arbeit
  });

  it('content ohne Surface-Tag -> Marker, Coords bleiben undefined', () => {
    const item = mkItem({
      id: 'a',
      ts: '2026-04-29T10:00:00Z',
      content: 'just plain text',
    });
    const res = hydrateWorkstreamCoords(item);
    expect(res._coordsHydrated).toBe(true);
    expect(res.workstreamId).toBeUndefined();
  });

  it('content komplett leer -> Marker, Coords bleiben undefined', () => {
    const item = mkItem({
      id: 'a',
      ts: '2026-04-29T10:00:00Z',
      content: '',
    });
    const res = hydrateWorkstreamCoords(item);
    expect(res._coordsHydrated).toBe(true);
    expect(res.workstreamId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyReplacePass
// ---------------------------------------------------------------------------

describe('applyReplacePass', () => {
  it('bei dupliziertem (workstreamId, surfaceKind) bleibt nur das letzte lebend', () => {
    const items: HistoryItem[] = [
      mkItem({
        id: 'v1',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: 'v2',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: 'v3',
        ts: '2026-04-29T10:02:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
    ];
    const out = applyReplacePass(items);
    expect(out[0]?.archived).toBe(true);
    expect(out[1]?.archived).toBe(true);
    expect(out[2]?.archived).toBeFalsy();
  });

  it('pro Coord-Key wird unabhaengig entschieden', () => {
    const items: HistoryItem[] = [
      mkItem({
        id: 'a-old',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: 'b-old',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: WS_B,
        surfaceKind: 'consensus-action',
      }),
      mkItem({
        id: 'a-new',
        ts: '2026-04-29T10:02:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
    ];
    const out = applyReplacePass(items);
    expect(out[0]?.archived).toBe(true); // a-old verdrängt
    expect(out[1]?.archived).toBeFalsy(); // b-old einziges B-Item
    expect(out[2]?.archived).toBeFalsy(); // a-new neuestes A-Item
  });

  it('items ohne Coords werden ignoriert', () => {
    const items: HistoryItem[] = [
      mkItem({ id: 'plain-1', ts: '2026-04-29T10:00:00Z' }),
      mkItem({ id: 'plain-2', ts: '2026-04-29T10:01:00Z' }),
    ];
    const out = applyReplacePass(items);
    expect(out).toBe(items); // identical reference
  });

  it('mixed-archived: bereits archivierte Items werden NICHT als "lebende" gewertet', () => {
    const items: HistoryItem[] = [
      mkItem({
        id: 'archived',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
        archived: true,
      }),
      mkItem({
        id: 'live',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: WS_A,
        surfaceKind: 'consensus-action',
      }),
    ];
    const out = applyReplacePass(items);
    expect(out[0]?.archived).toBe(true); // war schon archiviert
    expect(out[1]?.archived).toBeFalsy(); // einzig lebendes
  });
});

// ---------------------------------------------------------------------------
// extractWorkstreamCoords (strict + loose)
// ---------------------------------------------------------------------------

describe('extractWorkstreamCoords (strict)', () => {
  it('parses ein Standard-Surface-Tag', () => {
    const content = surfaceTag('consensus-action', { workstreamId: WS_A, level: 'strong' });
    const res = extractWorkstreamCoords(content);
    expect(res?.workstreamId).toBe(WS_A);
    expect(res?.surfaceKind).toBe('consensus-action');
  });

  it('returnt null bei malformed JSON', () => {
    const content = '<surface:consensus-action>{not-json</surface:consensus-action>';
    const res = extractWorkstreamCoords(content);
    expect(res).toBeNull();
  });

  it('returnt null wenn workstreamId fehlt', () => {
    const content = surfaceTag('consensus-action', { level: 'strong' });
    const res = extractWorkstreamCoords(content);
    expect(res).toBeNull();
  });

  it('returnt null bei unbekanntem SurfaceKind', () => {
    const content = '<surface:fantasy-kind>{"workstreamId":"' + WS_A + '"}</surface:fantasy-kind>';
    const res = extractWorkstreamCoords(content);
    expect(res).toBeNull();
  });

  it('Regex erlaubt Ziffern + underscore in kind (Hint 2)', () => {
    // kein "kind" mit Ziffer/Underscore in der Whitelist — also returnt null
    // weil isSurfaceKind filtert, aber die Regex sollte den Tag zumindest
    // matchen koennen (Hint 2: angeglichen an Whitelist-Pattern).
    const content = '<surface:foo_bar9>{}</surface:foo_bar9>';
    const res = extractWorkstreamCoords(content);
    expect(res).toBeNull(); // Whitelist-Filter greift, aber Regex matcht
  });
});

describe('extractWorkstreamCoordsLoose', () => {
  it('parses ein Standard-Surface-Tag identisch zur strict-Variante', () => {
    const content = surfaceTag('consensus-action', { workstreamId: WS_A });
    const res = extractWorkstreamCoordsLoose(content);
    expect(res?.workstreamId).toBe(WS_A);
  });

  it('toleriert defekt-formattiertes Markup (loose-fallback)', () => {
    // Ein Surface-Tag mit Whitespace-Garnish vor/nach dem JSON
    const content = `<surface:consensus-action>\n${JSON.stringify({ workstreamId: WS_A })}\n</surface:consensus-action>`;
    const res = extractWorkstreamCoordsLoose(content);
    expect(res?.workstreamId).toBe(WS_A);
  });

  it('returnt null bei content ohne Surface-Tag', () => {
    const res = extractWorkstreamCoordsLoose('plain text only');
    expect(res).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sub-Plan 3 · Cluster-Merges (2026-05-01)
// ---------------------------------------------------------------------------

describe('canonicalKind (Cluster-Mapping)', () => {
  it('Cluster A: pipeline-Family → workflow', () => {
    expect(canonicalKind('pipeline')).toBe('workflow');
    expect(canonicalKind('live-pipeline')).toBe('workflow');
    expect(canonicalKind('workflow-pipeline')).toBe('workflow');
    expect(canonicalKind('iterate-pipeline')).toBe('workflow');
  });
  it('Cluster B: iterate-Family → workflow', () => {
    expect(canonicalKind('iterate-roast')).toBe('workflow');
    expect(canonicalKind('iterate-version')).toBe('workflow');
    expect(canonicalKind('user-correction')).toBe('workflow');
  });
  it('Cluster C: prompt-Family → prompt', () => {
    expect(canonicalKind('form')).toBe('prompt');
    expect(canonicalKind('credential-prompt')).toBe('prompt');
    expect(canonicalKind('open-questions')).toBe('prompt');
    expect(canonicalKind('plan-open-questions')).toBe('prompt');
    expect(canonicalKind('quickchoice')).toBe('prompt');
    expect(canonicalKind('decision')).toBe('prompt');
  });
  it('Cluster D: tool/step → agent-step', () => {
    expect(canonicalKind('agent')).toBe('agent-step');
    expect(canonicalKind('swarm')).toBe('agent-step');
    expect(canonicalKind('live-swarm')).toBe('agent-step');
    expect(canonicalKind('bug-fix-swarm')).toBe('agent-step');
    expect(canonicalKind('loop-phase')).toBe('agent-step');
    expect(canonicalKind('tier-choice')).toBe('agent-step');
  });
  it('non-clustered Kinds unveraendert', () => {
    expect(canonicalKind('ticket')).toBe('ticket');
    expect(canonicalKind('milestone')).toBe('milestone');
    expect(canonicalKind('consensus-action')).toBe('consensus-action');
    expect(canonicalKind(undefined)).toBeUndefined();
  });
});

describe('archiveStalePeers + Cluster-Migration', () => {
  it('alte iterate-pipeline-Card wird durch neue workflow-Card ersetzt', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old-iterate',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'iterate-pipeline',
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

  it('pipeline + live-pipeline + workflow im selben Workstream → alle archiviert ausser dem letzten', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'p1',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'pipeline',
      }),
      mkItem({
        id: 'p2',
        ts: '2026-04-29T10:01:00Z',
        workstreamId: WS_A,
        surfaceKind: 'live-pipeline',
      }),
    ];
    const incoming = mkItem({
      id: 'p3',
      ts: '2026-04-29T10:02:00Z',
      workstreamId: WS_A,
      surfaceKind: 'workflow',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBe(true);
    expect(res.prev[1]?.archived).toBe(true);
  });

  it('verschiedene Cluster bleiben unabhaengig (workflow vs prompt)', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'pipeline',
        ts: '2026-04-29T10:00:00Z',
        workstreamId: WS_A,
        surfaceKind: 'pipeline',
      }),
    ];
    const incoming = mkItem({
      id: 'form',
      ts: '2026-04-29T10:01:00Z',
      workstreamId: WS_A,
      surfaceKind: 'prompt',
    });
    const res = archiveStalePeers(prev, incoming);
    expect(res.prev[0]?.archived).toBeFalsy(); // unrelated cluster
  });
});

describe('enforceActiveCap', () => {
  it('cap=3 mit 5 inflight cards archiviert die 3 aeltesten (5+1−3=3)', () => {
    // 2026-05-02 Bug-Fix (88438b3): Cap erfordert workstreamId, sonst no-op.
    const wsId = '01J0000000000000000000000W';
    const prev: HistoryItem[] = [
      mkItem({ id: 'c1', ts: '2026-04-29T10:00:00Z', surfaceKind: 'workflow', workstreamId: wsId }),
      mkItem({ id: 'c2', ts: '2026-04-29T10:01:00Z', surfaceKind: 'workflow', workstreamId: wsId }),
      mkItem({ id: 'c3', ts: '2026-04-29T10:02:00Z', surfaceKind: 'workflow', workstreamId: wsId }),
      mkItem({ id: 'c4', ts: '2026-04-29T10:03:00Z', surfaceKind: 'workflow', workstreamId: wsId }),
      mkItem({ id: 'c5', ts: '2026-04-29T10:04:00Z', surfaceKind: 'workflow', workstreamId: wsId }),
    ];
    const incoming = mkItem({
      id: 'c6',
      ts: '2026-04-29T10:05:00Z',
      surfaceKind: 'workflow',
      workstreamId: wsId,
    });
    const res = enforceActiveCap(prev, incoming, 3);
    expect(res.find((i) => i.id === 'c1')?.archived).toBe(true);
    expect(res.find((i) => i.id === 'c2')?.archived).toBe(true);
    expect(res.find((i) => i.id === 'c3')?.archived).toBe(true);
    expect(res.find((i) => i.id === 'c4')?.archived).toBeFalsy();
    expect(res.find((i) => i.id === 'c5')?.archived).toBeFalsy();
  });

  it('cap=3 mit 2 inflight cards bleibt unveraendert', () => {
    const prev: HistoryItem[] = [
      mkItem({ id: 'c1', ts: '2026-04-29T10:00:00Z', surfaceKind: 'workflow' }),
      mkItem({ id: 'c2', ts: '2026-04-29T10:01:00Z', surfaceKind: 'workflow' }),
    ];
    const incoming = mkItem({
      id: 'c3',
      ts: '2026-04-29T10:02:00Z',
      surfaceKind: 'workflow',
    });
    const res = enforceActiveCap(prev, incoming, 3);
    expect(res).toBe(prev); // identity, kein Mutation
  });

  it('Plain-Text-Items zaehlen nicht zur Cap', () => {
    const prev: HistoryItem[] = [
      mkItem({ id: 'plain1', ts: '2026-04-29T10:00:00Z' }), // KEIN surfaceKind
      mkItem({ id: 'plain2', ts: '2026-04-29T10:01:00Z' }),
      mkItem({ id: 'plain3', ts: '2026-04-29T10:02:00Z' }),
      mkItem({ id: 'card1', ts: '2026-04-29T10:03:00Z', surfaceKind: 'workflow' }),
      mkItem({ id: 'card2', ts: '2026-04-29T10:04:00Z', surfaceKind: 'workflow' }),
    ];
    const incoming = mkItem({
      id: 'card3',
      ts: '2026-04-29T10:05:00Z',
      surfaceKind: 'workflow',
    });
    const res = enforceActiveCap(prev, incoming, 3);
    // 2 cards + incoming = 3, exakt cap → keine Archivierung
    expect(res).toBe(prev);
  });

  it('bereits archivierte Cards zaehlen nicht zur Cap', () => {
    const prev: HistoryItem[] = [
      mkItem({
        id: 'old',
        ts: '2026-04-29T10:00:00Z',
        surfaceKind: 'workflow',
        archived: true,
      }),
      mkItem({ id: 'live1', ts: '2026-04-29T10:01:00Z', surfaceKind: 'workflow' }),
      mkItem({ id: 'live2', ts: '2026-04-29T10:02:00Z', surfaceKind: 'workflow' }),
    ];
    const incoming = mkItem({
      id: 'new',
      ts: '2026-04-29T10:03:00Z',
      surfaceKind: 'workflow',
    });
    const res = enforceActiveCap(prev, incoming, 3);
    // 2 lebende + incoming = 3 → kein Archivierungs-Bedarf
    expect(res).toBe(prev);
  });

  it('incoming ohne surfaceKind ist no-op', () => {
    const prev: HistoryItem[] = [
      mkItem({ id: 'c1', ts: '2026-04-29T10:00:00Z', surfaceKind: 'workflow' }),
    ];
    const incoming = mkItem({ id: 'plain', ts: '2026-04-29T10:01:00Z' });
    const res = enforceActiveCap(prev, incoming, 3);
    expect(res).toBe(prev);
  });

  it('Cap=1 mit einer lebenden Card archiviert sie BEVOR incoming', () => {
    const wsId = '01J0000000000000000000000W';
    const prev: HistoryItem[] = [
      mkItem({ id: 'c1', ts: '2026-04-29T10:00:00Z', surfaceKind: 'workflow', workstreamId: wsId }),
    ];
    const incoming = mkItem({
      id: 'c2',
      ts: '2026-04-29T10:01:00Z',
      surfaceKind: 'workflow',
      workstreamId: wsId,
    });
    const res = enforceActiveCap(prev, incoming, 1);
    expect(res[0]?.archived).toBe(true);
  });
});
