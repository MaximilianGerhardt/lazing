/**
 * Tests für Welle 7 (2026-05-01) — Loop-Phase-Persistence via emit-or-update-card
 * ------------------------------------------------------------------------------
 *
 * Sicherstellt dass derselbe Loop-Phase-Coord (Stage-Index, Version-N, Tier+Agent-
 * Idx, Roaster-Idx, …) als EINE Row in events landet und bei wiederholtem Emit
 * in-place upgedated wird, statt einen neuen Row zu erzeugen.
 *
 * Pattern: identisches vi.mock-Setup wie emit-or-update-card.test.ts (eigene
 * :memory:-DB pro Test).
 *
 * Cases:
 *   1. auto-dispatch-stage 2× mit gleicher Coord → 1 Row (UPDATE statt INSERT)
 *   2. iterate-version V1, V2, V3 → 3 Rows (verschiedene versionN-subKey)
 *   3. tier-output für 3 Tiers × 3 Agents → 9 Rows (alle koexistieren)
 *   4. subKey vs. kein subKey koexistieren (Backwards-Compat)
 *   5. subKey leerer String wirft Error
 *   6. iterate-roast: pro (roasterIdx, versionN) eine eigene Card
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let memDb: Database.Database;

const COLUMN_MAP: Record<string, string> = {
  id: 'id',
  createdAt: 'created_at',
  segmentId: 'segment_id',
  entityType: 'entity_type',
  entityId: 'entity_id',
  eventType: 'event_type',
  actor: 'actor',
  payload: 'payload',
  sensitivity: 'sensitivity',
  signature: 'signature',
  replayedFrom: 'replayed_from',
};

vi.mock('../../../db/client', () => ({
  getDb: () => ({
    $raw: memDb,
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        run: () => {
          const camelCols = Object.keys(row);
          const dbCols = camelCols.map((c) => COLUMN_MAP[c] ?? c);
          const placeholders = camelCols.map(() => '?').join(',');
          const stmt = memDb.prepare(
            `INSERT INTO events (${dbCols.join(',')}) VALUES (${placeholders})`,
          );
          stmt.run(
            ...camelCols.map((c) => {
              const v = row[c];
              return v === undefined ? null : v;
            }),
          );
        },
      }),
    }),
  }),
}));

vi.mock('../../push/triggers', () => ({
  schedulePushDispatch: () => undefined,
}));

vi.mock('../../tickets/auto-dispatch', () => ({
  maybeAutoDispatch: async () => undefined,
  maybeAutoCloseMaster: async () => undefined,
}));

vi.mock('../../routines/runner', () => ({
  findEventTriggeredRoutines: async () => [],
  executeRoutine: async () => undefined,
}));

import { emitOrUpdateCard } from '../../events/emit-or-update-card';
import {
  autoDispatchStageSubKey,
  iterateRoastSubKey,
  iterateVersionSubKey,
  tierOutputSubKey,
} from '../../events/loop-card-coords';

const EVENTS_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id              TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL,
    segment_id      TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT NOT NULL,
    event_type      TEXT NOT NULL,
    actor           TEXT NOT NULL,
    payload         TEXT NOT NULL DEFAULT '{}',
    sensitivity     TEXT NOT NULL DEFAULT 'low',
    signature       TEXT,
    replayed_from   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_segment_created
    ON events (segment_id, created_at DESC);
`;

const WS = 'demo-fitness';
const WSTREAM = '01J0LOOP000000000000000WS01';

function loopPhaseContent(
  kind: string,
  stage: string,
  marker: string,
): string {
  const surfacePayload = JSON.stringify({
    kind,
    workstreamId: WSTREAM,
    workspaceId: WS,
    stage,
    marker,
  });
  return `<surface:loop-phase>${surfacePayload}</surface:loop-phase>`;
}

function iterateVersionContent(versionN: number, marker: string): string {
  const surfacePayload = JSON.stringify({
    workstreamId: WSTREAM,
    workspaceId: WS,
    versionN,
    text: marker,
  });
  return `<surface:iterate-version>${surfacePayload}</surface:iterate-version>`;
}

function tierOutputContent(tier: string, agentIdx: number): string {
  const surfacePayload = JSON.stringify({
    kind: 'tier-output',
    workstreamId: WSTREAM,
    workspaceId: WS,
    tier,
    agentIdx,
  });
  return `<surface:loop-phase>${surfacePayload}</surface:loop-phase>`;
}

beforeEach(() => {
  memDb = new Database(':memory:');
  memDb.exec(EVENTS_DDL);
});

afterEach(() => {
  memDb?.close();
});

describe('Loop-Phase-Persistence (Welle 7)', () => {
  it('Case 1 — auto-dispatch-stage 2× mit gleicher Coord → 1 Row, in-place upgedated', async () => {
    const subKey = autoDispatchStageSubKey(0);
    const first = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'loop-phase',
        subKey,
      },
      content: loopPhaseContent('auto-dispatch-stage', 'senior-dev', 'tick-1'),
    });
    const second = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'loop-phase',
        subKey,
      },
      content: loopPhaseContent('auto-dispatch-stage', 'senior-dev', 'tick-2'),
    });

    expect(first.mode).toBe('inserted');
    expect(second.mode).toBe('updated');
    expect(second.event.id).toBe(first.event.id);

    const rows = memDb
      .prepare(`SELECT id, payload FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string; payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    expect(payload.cardSubKey).toBe('stage:0');
    expect(payload.content).toContain('tick-2');
    expect(payload.content).not.toContain('tick-1');
  });

  it('Case 2 — iterate-version V1, V2, V3 → 3 separate Rows (subKey unterscheidet)', async () => {
    for (const v of [1, 2, 3]) {
      const out = await emitOrUpdateCard({
        coords: {
          workspaceId: WS,
          workstreamId: WSTREAM,
          surfaceKind: 'iterate-version',
          subKey: iterateVersionSubKey(v),
        },
        content: iterateVersionContent(v, `body-V${v}`),
      });
      expect(out.mode).toBe('inserted');
    }

    const rows = memDb
      .prepare(
        `SELECT id, payload FROM events
          WHERE segment_id=?
            AND json_extract(payload, '$.surfaceKind')='iterate-version'`,
      )
      .all(WS) as Array<{ id: string; payload: string }>;
    expect(rows).toHaveLength(3);
    const subKeys = rows.map((r) => {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      return p.cardSubKey;
    });
    expect(subKeys.sort()).toEqual(['v:1', 'v:2', 'v:3']);

    // Re-Emit V2 → updated, kein neuer Row
    const reEmit = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'iterate-version',
        subKey: iterateVersionSubKey(2),
      },
      content: iterateVersionContent(2, 'body-V2-rev'),
    });
    expect(reEmit.mode).toBe('updated');
    const rowsAfter = memDb
      .prepare(
        `SELECT id FROM events
          WHERE segment_id=?
            AND json_extract(payload, '$.surfaceKind')='iterate-version'`,
      )
      .all(WS);
    expect(rowsAfter).toHaveLength(3);
  });

  it('Case 3 — tier-output für 3 Tiers × 3 Agents → 9 separate Rows', async () => {
    const tiers = ['opus', 'sonnet', 'haiku'];
    for (const t of tiers) {
      for (let agentIdx = 0; agentIdx < 3; agentIdx++) {
        const out = await emitOrUpdateCard({
          coords: {
            workspaceId: WS,
            workstreamId: WSTREAM,
            surfaceKind: 'loop-phase',
            subKey: tierOutputSubKey(t, agentIdx),
          },
          content: tierOutputContent(t, agentIdx),
        });
        expect(out.mode).toBe('inserted');
      }
    }
    const rows = memDb
      .prepare(`SELECT id FROM events WHERE segment_id=?`)
      .all(WS);
    expect(rows).toHaveLength(9);

    // Repeat-Emit für tier=opus, agentIdx=1 → updated
    const reEmit = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'loop-phase',
        subKey: tierOutputSubKey('opus', 1),
      },
      content: tierOutputContent('opus', 1),
    });
    expect(reEmit.mode).toBe('updated');
    const rowsAfter = memDb
      .prepare(`SELECT id FROM events WHERE segment_id=?`)
      .all(WS);
    expect(rowsAfter).toHaveLength(9);
  });

  it('Case 4 — Card OHNE subKey + Card MIT subKey koexistieren (Backwards-Compat)', async () => {
    // Kein subKey: legacy-pfad — z.B. consensus-action 1× pro workstream
    const noSub = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'loop-phase',
      },
      content: loopPhaseContent('auto-dispatch-overview', 'overview', 'no-sub'),
    });
    const withSub = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'loop-phase',
        subKey: autoDispatchStageSubKey(0),
      },
      content: loopPhaseContent('auto-dispatch-stage', 'senior-dev', 'with-sub'),
    });

    expect(noSub.mode).toBe('inserted');
    expect(withSub.mode).toBe('inserted');

    const rows = memDb
      .prepare(`SELECT id, payload FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string; payload: string }>;
    expect(rows).toHaveLength(2);

    // Re-Emit ohne subKey → matcht NUR die noSub-Card, nicht die withSub.
    const reNoSub = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'loop-phase',
      },
      content: loopPhaseContent(
        'auto-dispatch-overview',
        'overview',
        'no-sub-rev',
      ),
    });
    expect(reNoSub.mode).toBe('updated');
    expect(reNoSub.event.id).toBe(noSub.event.id);

    const rowsAfter = memDb
      .prepare(`SELECT id FROM events WHERE segment_id=?`)
      .all(WS);
    expect(rowsAfter).toHaveLength(2);
  });

  it('Case 5 — subKey leerer String wirft Error', async () => {
    await expect(
      emitOrUpdateCard({
        coords: {
          workspaceId: WS,
          workstreamId: WSTREAM,
          surfaceKind: 'loop-phase',
          subKey: '',
        },
        content: 'doesnt matter',
      }),
    ).rejects.toThrow(/subKey is set but empty/);
  });

  it('Case 6 — iterate-roast: 4 Roaster × 2 Versions = 8 separate Cards', async () => {
    for (let v = 1; v <= 2; v++) {
      for (let r = 1; r <= 4; r++) {
        const out = await emitOrUpdateCard({
          coords: {
            workspaceId: WS,
            workstreamId: WSTREAM,
            surfaceKind: 'iterate-roast',
            subKey: iterateRoastSubKey(r, v),
          },
          content: `<surface:iterate-roast>${JSON.stringify({
            workstreamId: WSTREAM,
            workspaceId: WS,
            roasterIdx: r,
            versionN: v,
            text: `roast-${r}-V${v}`,
          })}</surface:iterate-roast>`,
        });
        expect(out.mode).toBe('inserted');
      }
    }
    const rows = memDb
      .prepare(
        `SELECT id, payload FROM events
          WHERE segment_id=?
            AND json_extract(payload, '$.surfaceKind')='iterate-roast'`,
      )
      .all(WS) as Array<{ id: string; payload: string }>;
    expect(rows).toHaveLength(8);

    // Re-Emit r=2,v=1 → updated
    const reEmit = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM,
        surfaceKind: 'iterate-roast',
        subKey: iterateRoastSubKey(2, 1),
      },
      content: `<surface:iterate-roast>${JSON.stringify({
        workstreamId: WSTREAM,
        workspaceId: WS,
        roasterIdx: 2,
        versionN: 1,
        text: 'roast-2-V1-rev',
      })}</surface:iterate-roast>`,
    });
    expect(reEmit.mode).toBe('updated');
    const rowsAfter = memDb
      .prepare(
        `SELECT id FROM events
          WHERE segment_id=?
            AND json_extract(payload, '$.surfaceKind')='iterate-roast'`,
      )
      .all(WS);
    expect(rowsAfter).toHaveLength(8);
  });
});
