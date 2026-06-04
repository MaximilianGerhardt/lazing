/**
 * Tests für `emitOrUpdateCard` (Sub-Plan C · 2026-04-30).
 * --------------------------------------------------------
 *
 * Pattern: vi.mock auf `db/client` mit eigener `:memory:`-DB-Instanz pro
 * Test, analog zu `server/streaming-snapshots.test.ts`. Das vermeidet
 * dass die echten 35+ Migrations laufen müssen — wir brauchen nur die
 * `events`-Tabelle.
 *
 * Cases:
 *   1. First-Emit                     -> mode='inserted', neuer Row
 *   2. Repeat-Emit (gleiche Coords)   -> mode='updated', payload.content neu
 *   3. Repeat-Emit (andere Kind)      -> mode='inserted', zweiter Row koexistiert
 *   4. Race-Doppel-Insert             -> zweiter Caller findet ersten und updated
 *   5. Validation: leere Coords werfen Error
 *   6. TTL-Expiry: alte Card → neuer Insert, kein Update
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock von db/client BEFORE der eigentliche Import — sonst landet
// emit.ts auf der echten DB. ----
let memDb: Database.Database;

// Drizzle-Mapping camelCase → snake_case wie es das echte schema/events.ts
// definiert. emit.ts uebergibt camelCase-Keys (createdAt, segmentId, ...),
// die echte Drizzle-Layer mappt sie auf die snake_case-Spalten der DB.
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
    // emit.ts ruft `db.insert(events).values(...)` — wir brauchen einen
    // minimalen drizzle-shim damit das funktioniert. Statt drizzle ein-
    // zubinden simulieren wir die Methodenkette mit einem Proxy der raw-SQL
    // schreibt. Für unsere Tests reicht das.
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        run: () => {
          const camelCols = Object.keys(row);
          const dbCols = camelCols.map(
            (c) => COLUMN_MAP[c] ?? c,
          );
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

// ---- Push-Triggers + Routines + Auto-Dispatch deaktivieren — sonst
// versuchen sie die echten Tabellen zu lesen. ----
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

// ---- Sensitivity-Layer braucht keine DB, signPayload/autoUpgrade laufen
// pure auf input. Lassen wir wie es ist.

// Erst nach den Mocks die zu testenden Module laden.
import { emitOrUpdateCard } from '../../events/emit-or-update-card';

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

const WS = 'lazyos';
const WSTREAM_A = '01J0000000000000000000000A';
const WSTREAM_B = '01J0000000000000000000000B';

function buildContent(workstreamId: string, kind: string, marker: string): string {
  const surfacePayload = JSON.stringify({
    workstreamId,
    workspaceId: WS,
    marker,
  });
  return [
    `Card-Update: ${marker}`,
    '',
    `<surface:${kind}>${surfacePayload}</surface:${kind}>`,
  ].join('\n');
}

beforeEach(() => {
  memDb = new Database(':memory:');
  memDb.exec(EVENTS_DDL);
});

afterEach(() => {
  memDb?.close();
});

describe('emitOrUpdateCard', () => {
  it('Case 1 — First-Emit erzeugt einen neuen Row', async () => {
    const out = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'V1'),
    });

    expect(out.mode).toBe('inserted');
    expect(out.event.eventType).toBe('chat_message_completed');

    const rows = memDb
      .prepare(`SELECT id, payload FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string; payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    expect(payload.surfaceKind).toBe('iterate-pipeline');
    expect(payload.workstreamId).toBe(WSTREAM_A);
    expect(payload.content).toContain('V1');
  });

  it('Case 2 — Repeat-Emit mit gleichen Coords updated den existing Row in-place', async () => {
    const first = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'V1'),
    });
    expect(first.mode).toBe('inserted');

    const second = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'V2'),
    });
    expect(second.mode).toBe('updated');
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.createdAt).toBe(first.event.createdAt);

    const rows = memDb
      .prepare(`SELECT id, payload FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string; payload: string }>;
    // Genau EIN Row — kein Doppel-Insert.
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    expect(payload.content).toContain('V2');
    expect(payload.content).not.toContain('V1');
    expect(typeof payload.updatedAt).toBe('number');
  });

  it('Case 3 — Andere surfaceKind koexistiert (nicht gemerged)', async () => {
    const a = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'plan'),
    });
    const b = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'consensus-action',
      },
      content: buildContent(WSTREAM_A, 'consensus-action', 'final'),
    });

    expect(a.mode).toBe('inserted');
    expect(b.mode).toBe('inserted');

    const rows = memDb
      .prepare(`SELECT id FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);

    // Anderer workstreamId triggert separat einen Insert
    const c = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_B,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_B, 'iterate-pipeline', 'plan-B'),
    });
    expect(c.mode).toBe('inserted');

    const rowsAfter = memDb
      .prepare(`SELECT id FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string }>;
    expect(rowsAfter).toHaveLength(3);
  });

  it('Case 4 — Race: zweiter Caller mit gleichen Coords updated denselben Row', async () => {
    // better-sqlite3 ist synchron — echte parallele INSERTs gibt's hier nicht.
    // Wir simulieren das realistische Race-Szenario: zwei sequentielle
    // emits mit identischen Coords. Der zweite MUSS den ersten finden und
    // updaten statt einen neuen Row zu erzeugen.
    const r1 = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'concurrent-1'),
    });
    const r2 = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'concurrent-2'),
    });

    expect(r1.mode).toBe('inserted');
    expect(r2.mode).toBe('updated');
    expect(r2.event.id).toBe(r1.event.id);

    const rows = memDb
      .prepare(`SELECT id, payload FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string; payload: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload) as Record<string, unknown>;
    expect(payload.content).toContain('concurrent-2');
  });

  it('Case 5 — Validation: leere Coords werfen Error', async () => {
    await expect(
      emitOrUpdateCard({
        coords: {
          workspaceId: '',
          workstreamId: WSTREAM_A,
          surfaceKind: 'iterate-pipeline',
        },
        content: 'doesnt matter',
      }),
    ).rejects.toThrow(/coords must be fully populated/);

    await expect(
      emitOrUpdateCard({
        coords: {
          workspaceId: WS,
          workstreamId: '',
          surfaceKind: 'iterate-pipeline',
        },
        content: 'doesnt matter',
      }),
    ).rejects.toThrow(/coords must be fully populated/);
  });

  it('Case 6 — TTL: alte Card jenseits des 24h-Fensters bekommt einen neuen Row', async () => {
    const first = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'old'),
    });
    expect(first.mode).toBe('inserted');

    // created_at künstlich 48h zurückdatieren — Card jenseits des 24h-TTL.
    memDb
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(Date.now() - 48 * 60 * 60 * 1000, first.event.id);

    const second = await emitOrUpdateCard({
      coords: {
        workspaceId: WS,
        workstreamId: WSTREAM_A,
        surfaceKind: 'iterate-pipeline',
      },
      content: buildContent(WSTREAM_A, 'iterate-pipeline', 'fresh'),
    });
    expect(second.mode).toBe('inserted');
    expect(second.event.id).not.toBe(first.event.id);

    const rows = memDb
      .prepare(`SELECT id FROM events WHERE segment_id=?`)
      .all(WS) as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
  });
});
