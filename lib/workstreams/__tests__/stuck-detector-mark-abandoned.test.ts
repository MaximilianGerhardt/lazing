/**
 * Tests fuer markAbandonedStuckWorkstreams (Owner-Fix 2026-05-28).
 *
 * Begleiter zum Live-Filter in /api/activity/live. Diese Funktion ist
 * NICHT auto-aufgerufen — Owner-Aufruf.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *   lib/workstreams/__tests__/stuck-detector-mark-abandoned.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markAbandonedStuckWorkstreams } from '../stuck-detector';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface FakeRow {
  id: string;
  workspace_id: string;
  updated_at: number;
  status: string;
}

let rows: FakeRow[] = [];

const selectStmt = {
  all: vi.fn<AnyFn>(),
};
const updateStmt = {
  run: vi.fn<AnyFn>(),
};
let lastPreparedSql: string | null = null;

const dbRaw = {
  prepare: vi.fn<AnyFn>((sql: string) => {
    lastPreparedSql = sql;
    if (/^SELECT/i.test(sql.trim())) return selectStmt;
    if (/^UPDATE/i.test(sql.trim())) return updateStmt;
    return selectStmt;
  }),
};

vi.mock('@/db/client', () => ({
  getDb: () => ({ $raw: dbRaw }),
}));

// Direkter Pfad-Mock (Modul wird mit relativem Pfad importiert).
vi.mock('../../../db/client', () => ({
  getDb: () => ({ $raw: dbRaw }),
}));

describe('markAbandonedStuckWorkstreams', () => {
  beforeEach(() => {
    rows = [];
    selectStmt.all.mockReset();
    updateStmt.run.mockReset();
    dbRaw.prepare.mockClear();
    lastPreparedSql = null;
    selectStmt.all.mockImplementation((cutoff: number) => {
      return rows.filter(
        (r) => r.status === 'stuck' && r.updated_at < cutoff,
      );
    });
    updateStmt.run.mockImplementation((newUpdatedAt: number, id: string) => {
      const r = rows.find((x) => x.id === id && x.status === 'stuck');
      if (r) {
        r.status = 'abandoned';
        r.updated_at = newUpdatedAt;
      }
      return { changes: r ? 1 : 0 };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('markiert alte stuck-WS als abandoned', () => {
    const now = 10_000_000;
    rows = [
      { id: 'a', workspace_id: 'w', status: 'stuck', updated_at: now - 25 * 3600_000 }, // 25h alt
      { id: 'b', workspace_id: 'w', status: 'stuck', updated_at: now - 1 * 3600_000 },  // 1h alt
      { id: 'c', workspace_id: 'w', status: 'active', updated_at: now - 50 * 3600_000 }, // active = nicht angefasst
    ];

    const res = markAbandonedStuckWorkstreams({
      olderThanMs: 6 * 3600_000,
      now,
    });

    expect(res.scanned).toBe(1);
    expect(res.marked).toEqual(['a']);
    expect(rows.find((r) => r.id === 'a')?.status).toBe('abandoned');
    expect(rows.find((r) => r.id === 'b')?.status).toBe('stuck');
    expect(rows.find((r) => r.id === 'c')?.status).toBe('active');
  });

  it('dryRun=true markiert nichts', () => {
    const now = 10_000_000;
    rows = [
      { id: 'a', workspace_id: 'w', status: 'stuck', updated_at: now - 25 * 3600_000 },
    ];

    const res = markAbandonedStuckWorkstreams({
      olderThanMs: 6 * 3600_000,
      now,
      dryRun: true,
    });

    expect(res.scanned).toBe(1);
    expect(res.marked).toEqual([]);
    expect(res.details[0]?.workstreamId).toBe('a');
    expect(rows[0]?.status).toBe('stuck');
    expect(updateStmt.run).not.toHaveBeenCalled();
  });

  it('idempotent: zweiter Aufruf macht nichts', () => {
    const now = 10_000_000;
    rows = [
      { id: 'a', workspace_id: 'w', status: 'stuck', updated_at: now - 25 * 3600_000 },
    ];

    const first = markAbandonedStuckWorkstreams({ olderThanMs: 6 * 3600_000, now });
    expect(first.marked).toEqual(['a']);

    // Zweiter Aufruf: 'a' ist jetzt abandoned, das SELECT filtert ihn raus.
    const second = markAbandonedStuckWorkstreams({ olderThanMs: 6 * 3600_000, now });
    expect(second.marked).toEqual([]);
    expect(second.scanned).toBe(0);
  });

  it('Default olderThanMs ist 6h', () => {
    const now = 10_000_000;
    rows = [
      { id: 'a', workspace_id: 'w', status: 'stuck', updated_at: now - 7 * 3600_000 }, // 7h alt
      { id: 'b', workspace_id: 'w', status: 'stuck', updated_at: now - 5 * 3600_000 }, // 5h alt
    ];

    const res = markAbandonedStuckWorkstreams({ now });
    expect(res.marked).toEqual(['a']);
  });

  it('leere Stuck-Liste = no-op (fail-soft)', () => {
    rows = [];
    const res = markAbandonedStuckWorkstreams();
    expect(res.scanned).toBe(0);
    expect(res.marked).toEqual([]);
    expect(updateStmt.run).not.toHaveBeenCalled();
  });
});
