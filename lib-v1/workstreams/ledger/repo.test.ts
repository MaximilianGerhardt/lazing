// SPDX-License-Identifier: GPL-3.0-or-later
// M-EVID-01 — Detail-Ledger tests.
// Authority: modules/W2/M-EVID-01/DETAIL-LEDGER-DDL.md §5 (T1-T14).

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  WorkstreamDetailLedgerRepo,
  SupersededError,
  InvalidSupersedeError,
} from './repo';
import { canonicalize } from '../../audit/canonical-json';
import { freshSliceBDb, seedWorkstream } from '../__tests__/_fresh-db';

describe('M-EVID-01 / WorkstreamDetailLedgerRepo', () => {
  let db: Database.Database;
  let repo: WorkstreamDetailLedgerRepo;
  let ws: string;

  beforeEach(() => {
    db = freshSliceBDb();
    repo = new WorkstreamDetailLedgerRepo(db);
    ws = seedWorkstream(db);
  });

  it('T1: appendLedger is idempotent on identical payload', () => {
    const payload = { kind: 'plan', body: 'x'.repeat(5_000), order: 1 };

    const r1 = repo.appendLedger({ workstreamId: ws, payload });
    const r2 = repo.appendLedger({ workstreamId: ws, payload });

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r2.id).toBe(r1.id);
    expect(r2.contentHash).toBe(r1.contentHash);
    expect(repo.getLedger(ws)).toHaveLength(1);
  });

  it('T2: same content_hash collapses to 1 row across reordered keys', () => {
    const r1 = repo.appendLedger({
      workstreamId: ws,
      payload: { a: 1, b: 2, nested: { x: 1, y: 2 } },
    });
    const r2 = repo.appendLedger({
      workstreamId: ws,
      payload: { nested: { y: 2, x: 1 }, b: 2, a: 1 },
    });

    expect(r2.id).toBe(r1.id);
    expect(repo.getLedger(ws)).toHaveLength(1);
  });

  it('T3: payload roundtrips through canonical-JSON without N1-loss', () => {
    // -0 canonicalizes to 0 per JCS RFC-8785; track expected canonical form.
    const payload = {
      body: 'Multiline\nWith\tTabs\nUnicode: ä ö ü 🚀 ñ',
      nested: {
        numbers: [1, 2.5, 0, 1e10],
        booleans: [true, false],
        nulls: [null],
      },
      longArray: Array.from({ length: 200 }, (_, i) => ({
        idx: i,
        val: `row-${i}`,
      })),
    };

    const r = repo.appendLedger({ workstreamId: ws, payload });
    const row = repo.findByHash(ws, r.contentHash)!;
    const parsed = JSON.parse(row.payload_jsonb);

    // N1: structural equality (key order may differ but content identical).
    expect(parsed).toEqual(payload);
    // Deterministic property — re-canonicalize equals stored bytes.
    expect(canonicalize(parsed)).toBe(row.payload_jsonb);
  });

  it('T4: different payloads produce different rows', () => {
    const r1 = repo.appendLedger({
      workstreamId: ws,
      payload: { kind: 'a' },
    });
    const r2 = repo.appendLedger({
      workstreamId: ws,
      payload: { kind: 'b' },
    });
    expect(r1.contentHash).not.toBe(r2.contentHash);
    expect(repo.getLedger(ws)).toHaveLength(2);
  });

  it('T5: cross-workstream same payload → 2 rows (UNIQUE is (ws, hash))', () => {
    const ws2 = seedWorkstream(db);
    const payload = { kind: 'common' };
    const r1 = repo.appendLedger({ workstreamId: ws, payload });
    const r2 = repo.appendLedger({ workstreamId: ws2, payload });
    expect(r1.contentHash).toBe(r2.contentHash);
    expect(r1.id).not.toBe(r2.id);
    expect(repo.getLedger(ws)).toHaveLength(1);
    expect(repo.getLedger(ws2)).toHaveLength(1);
  });

  it('T6: supersedeLedger with valid predecessor flips predecessor', () => {
    const r1 = repo.appendLedger({
      workstreamId: ws,
      payload: { kind: 'plan', body: 'v1' },
    });
    const r2 = repo.supersedeLedger({
      workstreamId: ws,
      predecessorId: r1.id,
      payload: { kind: 'plan', body: 'v2' },
    });

    expect(r2.inserted).toBe(true);
    expect(repo.getLedger(ws)).toHaveLength(2);
    const current = repo.getCurrentLedger(ws);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(r2.id);
    const predecessor = repo.findByHash(ws, r1.contentHash)!;
    expect(predecessor.superseded_at).not.toBeNull();
    expect(predecessor.superseded_by).toBe(r2.id);
  });

  it('T7: supersedeLedger with already-superseded predecessor throws SupersededError', () => {
    const r1 = repo.appendLedger({
      workstreamId: ws,
      payload: { v: 1 },
    });
    repo.supersedeLedger({
      workstreamId: ws,
      predecessorId: r1.id,
      payload: { v: 2 },
    });
    expect(() =>
      repo.supersedeLedger({
        workstreamId: ws,
        predecessorId: r1.id,
        payload: { v: 3 },
      }),
    ).toThrow(SupersededError);
  });

  it('T8: getCurrentLedger filters superseded rows', () => {
    const r1 = repo.appendLedger({ workstreamId: ws, payload: { v: 1 } });
    repo.supersedeLedger({
      workstreamId: ws,
      predecessorId: r1.id,
      payload: { v: 2 },
    });
    expect(repo.getCurrentLedger(ws)).toHaveLength(1);
    expect(repo.getLedger(ws)).toHaveLength(2);
  });

  it('T9: FK ON DELETE RESTRICT blocks workstream delete with dangling ledger', () => {
    repo.appendLedger({ workstreamId: ws, payload: { v: 1 } });
    expect(() =>
      db.prepare(`DELETE FROM workstreams WHERE id = ?`).run(ws),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('T10: 100 sequential appends with different hashes produce 100 rows', () => {
    for (let i = 0; i < 100; i++) {
      const r = repo.appendLedger({
        workstreamId: ws,
        payload: { i, body: `payload-${i}` },
      });
      expect(r.inserted).toBe(true);
    }
    expect(repo.getLedger(ws)).toHaveLength(100);
  });

  it('T11: 100 sequential appends with identical hash produce 1 row', () => {
    const payload = { stable: 'value' };
    let firstId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = repo.appendLedger({ workstreamId: ws, payload });
      if (i === 0) {
        expect(r.inserted).toBe(true);
        firstId = r.id;
      } else {
        expect(r.inserted).toBe(false);
        expect(r.id).toBe(firstId);
      }
    }
    expect(repo.getLedger(ws)).toHaveLength(1);
  });

  it('T12: findByHash returns undefined for unknown hash', () => {
    expect(repo.findByHash(ws, 'a'.repeat(64))).toBeUndefined();
  });

  it('T13 [BUG-FIX-1]: DB-trigger blocks UPDATE on payload_jsonb / content_hash', () => {
    const r = repo.appendLedger({
      workstreamId: ws,
      payload: { kind: 'plan', body: 'v1' },
    });

    expect(() =>
      db
        .prepare(
          `UPDATE workstream_detail_ledger SET payload_jsonb = ? WHERE id = ?`,
        )
        .run(JSON.stringify({ tampered: true }), r.id),
    ).toThrow(/payload_jsonb and content_hash are append-only/);

    expect(() =>
      db
        .prepare(
          `UPDATE workstream_detail_ledger SET content_hash = ? WHERE id = ?`,
        )
        .run('0'.repeat(64), r.id),
    ).toThrow(/payload_jsonb and content_hash are append-only/);

    // State-machine columns (superseded_at, superseded_by) remain mutable.
    expect(() =>
      db
        .prepare(
          `UPDATE workstream_detail_ledger SET superseded_at = ? WHERE id = ?`,
        )
        .run(Math.floor(Date.now() / 1000), r.id),
    ).not.toThrow();
  });

  it('T14 [BUG-FIX-1]: supersedeLedger rejects byte-identical payload', () => {
    const payload = { kind: 'plan', body: 'v1' };
    const r1 = repo.appendLedger({ workstreamId: ws, payload });

    expect(() =>
      repo.supersedeLedger({
        workstreamId: ws,
        predecessorId: r1.id,
        payload,
      }),
    ).toThrow(InvalidSupersedeError);

    // Predecessor still current after rollback.
    const current = repo.getCurrentLedger(ws);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).toBe(r1.id);
    expect(current[0]!.superseded_at).toBeNull();

    // Genuinely different payload succeeds.
    const r2 = repo.supersedeLedger({
      workstreamId: ws,
      predecessorId: r1.id,
      payload: { kind: 'plan', body: 'v2' },
    });
    expect(r2.inserted).toBe(true);
    expect(repo.getLedger(ws)).toHaveLength(2);
  });
});
