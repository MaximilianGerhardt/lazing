/**
 * Tests fuer reapStaleWorkstreams (Owner-Fix 2026-05-29 · Stuck-Reaper).
 *
 * Deckt ab (N6 deterministisch):
 *   - stuck > 6h wird gereapt (→ archived)
 *   - frischer stuck (< 6h) bleibt stuck
 *   - bereits archived/done bleiben unberuehrt (SELECT faengt sie nicht)
 *   - active ohne Heartbeat > 30min wird gereapt
 *   - frischer active (< 30min) bleibt active
 *   - dryRun markiert nichts + schreibt keine Decision
 *   - idempotent: zweiter Lauf = no-op
 *   - N8: pro Reap eine writeDecision-Row
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *   lib/workstreams/__tests__/reap-stale.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reapStaleWorkstreams,
  reapOrphanedFlowRuns,
  __resetReapGuardForTests,
  __resetFlowRunReapGuardForTests,
  DEFAULT_STUCK_MAX_AGE_MS,
  DEFAULT_ACTIVE_MAX_SILENCE_MS,
  DEFAULT_FLOW_RUN_MAX_AGE_MS,
} from '../reap-stale';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

interface FakeRow {
  id: string;
  workspace_id: string;
  status: string;
  updated_at: number;
}

let rows: FakeRow[] = [];

const selectStmt = { all: vi.fn<AnyFn>() };
const updateStmt = { run: vi.fn<AnyFn>() };

const dbRaw = {
  prepare: vi.fn<AnyFn>((sql: string) => {
    if (/^\s*SELECT/i.test(sql)) return selectStmt;
    if (/^\s*UPDATE/i.test(sql)) return updateStmt;
    return selectStmt;
  }),
};

// writeDecision-Spy (N8-Verifikation).
const writeDecisionSpy = vi.fn<AnyFn>(() => 'dec_x');

vi.mock('@/db/client', () => ({ getDb: () => ({ $raw: dbRaw }) }));
vi.mock('../../../db/client', () => ({ getDb: () => ({ $raw: dbRaw }) }));
vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (...a: unknown[]) => writeDecisionSpy(...a),
}));
vi.mock('../trace-repo', () => ({
  writeDecision: (...a: unknown[]) => writeDecisionSpy(...a),
}));

const H = 3600_000;
const MIN = 60_000;

describe('reapStaleWorkstreams', () => {
  beforeEach(() => {
    rows = [];
    __resetReapGuardForTests();
    selectStmt.all.mockReset();
    updateStmt.run.mockReset();
    writeDecisionSpy.mockClear();
    dbRaw.prepare.mockClear();

    // SELECT-Mock: bildet das WHERE der reap-Query nach.
    selectStmt.all.mockImplementation(
      (stuckCutoff: number, activeCutoff: number, limit: number) => {
        return rows
          .filter(
            (r) =>
              (r.status === 'stuck' && (r.updated_at ?? 0) < stuckCutoff) ||
              (r.status === 'active' && (r.updated_at ?? 0) < activeCutoff),
          )
          .sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
          .slice(0, limit);
      },
    );

    // UPDATE-Mock: status-geguardet, setzt auf 'archived'.
    updateStmt.run.mockImplementation(
      (newUpdatedAt: number, id: string, expectedStatus: string) => {
        const r = rows.find((x) => x.id === id && x.status === expectedStatus);
        if (r) {
          r.status = 'archived';
          r.updated_at = newUpdatedAt;
          return { changes: 1 };
        }
        return { changes: 0 };
      },
    );
  });

  afterEach(() => vi.clearAllMocks());

  it('stuck > 6h wird auf archived gereapt + frischer stuck bleibt', () => {
    const now = 100_000_000;
    rows = [
      { id: 'old', workspace_id: 'w', status: 'stuck', updated_at: now - 7 * H }, // 7h
      { id: 'fresh', workspace_id: 'w', status: 'stuck', updated_at: now - 1 * H }, // 1h
    ];

    const res = reapStaleWorkstreams({ now });

    expect(res.reaped).toEqual(['old']);
    expect(rows.find((r) => r.id === 'old')?.status).toBe('archived');
    expect(rows.find((r) => r.id === 'fresh')?.status).toBe('stuck');
  });

  it('archived/done bleiben unberuehrt (SELECT faengt sie nicht)', () => {
    const now = 100_000_000;
    rows = [
      { id: 'arch', workspace_id: 'w', status: 'archived', updated_at: now - 99 * H },
      { id: 'done', workspace_id: 'w', status: 'done', updated_at: now - 99 * H },
    ];

    const res = reapStaleWorkstreams({ now });

    expect(res.scanned).toBe(0);
    expect(res.reaped).toEqual([]);
    expect(updateStmt.run).not.toHaveBeenCalled();
  });

  it('active ohne Heartbeat > 30min wird gereapt, frischer active bleibt', () => {
    const now = 100_000_000;
    rows = [
      { id: 'silent', workspace_id: 'w', status: 'active', updated_at: now - 45 * MIN },
      { id: 'live', workspace_id: 'w', status: 'active', updated_at: now - 5 * MIN },
    ];

    const res = reapStaleWorkstreams({ now });

    expect(res.reaped).toEqual(['silent']);
    expect(rows.find((r) => r.id === 'silent')?.status).toBe('archived');
    expect(rows.find((r) => r.id === 'live')?.status).toBe('active');
  });

  it('dryRun markiert nichts + schreibt keine Decision', () => {
    const now = 100_000_000;
    rows = [{ id: 'old', workspace_id: 'w', status: 'stuck', updated_at: now - 7 * H }];

    const res = reapStaleWorkstreams({ now, dryRun: true });

    expect(res.scanned).toBe(1);
    expect(res.reaped).toEqual([]);
    expect(res.details[0]?.workstreamId).toBe('old');
    expect(res.details[0]?.previousStatus).toBe('stuck');
    expect(rows[0]?.status).toBe('stuck');
    expect(updateStmt.run).not.toHaveBeenCalled();
    expect(writeDecisionSpy).not.toHaveBeenCalled();
  });

  it('N8: pro Reap genau eine writeDecision-Row (policy/orphan_detected)', () => {
    const now = 100_000_000;
    rows = [
      { id: 'a', workspace_id: 'w1', status: 'stuck', updated_at: now - 10 * H },
      { id: 'b', workspace_id: 'w2', status: 'active', updated_at: now - 40 * MIN },
    ];

    reapStaleWorkstreams({ now });

    expect(writeDecisionSpy).toHaveBeenCalledTimes(2);
    const call = writeDecisionSpy.mock.calls[0][0];
    expect(call.decisionKind).toBe('orphan_detected');
    expect(call.actor).toBe('policy');
    expect(typeof call.rationale).toBe('string');
    expect(call.rationale.length).toBeGreaterThan(10);
  });

  it('idempotent: zweiter Lauf reapt nichts mehr', () => {
    const now = 100_000_000;
    rows = [{ id: 'old', workspace_id: 'w', status: 'stuck', updated_at: now - 7 * H }];

    const first = reapStaleWorkstreams({ now });
    expect(first.reaped).toEqual(['old']);

    __resetReapGuardForTests();
    const second = reapStaleWorkstreams({ now });
    expect(second.reaped).toEqual([]);
    expect(second.scanned).toBe(0);
  });

  it('leere Liste = no-op (fail-soft)', () => {
    rows = [];
    const res = reapStaleWorkstreams();
    expect(res.scanned).toBe(0);
    expect(res.reaped).toEqual([]);
    expect(updateStmt.run).not.toHaveBeenCalled();
  });

  it('Defaults: 6h stuck / 30min active', () => {
    expect(DEFAULT_STUCK_MAX_AGE_MS).toBe(6 * H);
    expect(DEFAULT_ACTIVE_MAX_SILENCE_MS).toBe(30 * MIN);
  });
});

// ---------------------------------------------------------------------------
// reapOrphanedFlowRuns — Reliability-Sweep 2026-05-30
//
// Eigene DB-Mock-Verdrahtung: die flow_run-Reaper-Query ist ein JOIN-SELECT
// (flow_runs ⋈ workstreams) + ein UPDATE flow_runs. Wir bilden das WHERE
// (status pending/running + Alters-Schwelle + terminaler/fehlender Workstream)
// im Mock nach und routen prepare() per SQL-Form.
// ---------------------------------------------------------------------------

interface FakeFlowRow {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  updated_at: number | null;
  /** Terminal-Status des zugehoerigen Workstreams, oder null = kein/fehlender WS. */
  ws_status: 'active' | 'paused' | 'done' | 'archived' | 'cancelled' | 'stuck' | null;
}

describe('reapOrphanedFlowRuns', () => {
  let flowRows: FakeFlowRow[] = [];
  const frSelect = { all: vi.fn<AnyFn>() };
  const frUpdate = { run: vi.fn<AnyFn>() };

  const TERMINAL = new Set(['done', 'archived', 'cancelled', 'stuck']);

  beforeEach(() => {
    flowRows = [];
    __resetFlowRunReapGuardForTests();
    frSelect.all.mockReset();
    frUpdate.run.mockReset();

    dbRaw.prepare.mockImplementation((sql: string) => {
      if (/UPDATE\s+flow_runs/i.test(sql)) return frUpdate;
      if (/FROM\s+flow_runs/i.test(sql)) return frSelect;
      // Fallback auf die Workstream-Stmts (falls je gerufen).
      if (/^\s*UPDATE/i.test(sql)) return updateStmt;
      return selectStmt;
    });

    // SELECT-Mock: bildet das orphan-WHERE nach (cutoff, limit).
    frSelect.all.mockImplementation((cutoff: number, limit: number) => {
      return flowRows
        .filter(
          (r) =>
            (r.status === 'pending' || r.status === 'running') &&
            (r.updated_at ?? 0) < cutoff &&
            (r.ws_status === null || TERMINAL.has(r.ws_status)),
        )
        .sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0))
        .slice(0, limit)
        .map((r) => ({ id: r.id }));
    });

    // UPDATE-Mock: status-geguardet → cancelled.
    frUpdate.run.mockImplementation((now: number, _msg: string, id: string) => {
      const r = flowRows.find(
        (x) => x.id === id && (x.status === 'pending' || x.status === 'running'),
      );
      if (r) {
        r.status = 'cancelled';
        r.updated_at = now;
        return { changes: 1 };
      }
      return { changes: 0 };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    // prepare-Mock fuer den anderen describe wiederherstellen passiert dort im beforeEach.
  });

  it('pending OHNE Workstream + alt → cancelled', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'orphan', status: 'pending', updated_at: now - 60 * MIN, ws_status: null },
    ];
    const res = reapOrphanedFlowRuns({ now });
    expect(res.reaped).toEqual(['orphan']);
    expect(flowRows[0]?.status).toBe('cancelled');
  });

  it('pending mit TERMINAL-Workstream + alt → cancelled', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'term', status: 'running', updated_at: now - 60 * MIN, ws_status: 'archived' },
    ];
    const res = reapOrphanedFlowRuns({ now });
    expect(res.reaped).toEqual(['term']);
    expect(flowRows[0]?.status).toBe('cancelled');
  });

  it('pending mit LEBENDEM (active) Workstream wird NIE gereapt', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'live', status: 'running', updated_at: now - 60 * MIN, ws_status: 'active' },
      { id: 'paused', status: 'pending', updated_at: now - 60 * MIN, ws_status: 'paused' },
    ];
    const res = reapOrphanedFlowRuns({ now });
    expect(res.scanned).toBe(0);
    expect(res.reaped).toEqual([]);
    expect(frUpdate.run).not.toHaveBeenCalled();
    expect(flowRows.every((r) => r.status !== 'cancelled')).toBe(true);
  });

  it('frischer orphan (< 30min) bleibt pending', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'recent', status: 'pending', updated_at: now - 5 * MIN, ws_status: null },
    ];
    const res = reapOrphanedFlowRuns({ now });
    expect(res.reaped).toEqual([]);
    expect(flowRows[0]?.status).toBe('pending');
  });

  it('done/failed flow_runs bleiben unberuehrt', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'd', status: 'done', updated_at: now - 99 * H, ws_status: 'archived' },
      { id: 'f', status: 'failed', updated_at: now - 99 * H, ws_status: null },
    ];
    const res = reapOrphanedFlowRuns({ now });
    expect(res.scanned).toBe(0);
    expect(frUpdate.run).not.toHaveBeenCalled();
  });

  it('dryRun reapt nichts', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'orphan', status: 'pending', updated_at: now - 60 * MIN, ws_status: null },
    ];
    const res = reapOrphanedFlowRuns({ now, dryRun: true });
    expect(res.scanned).toBe(1);
    expect(res.reaped).toEqual([]);
    expect(frUpdate.run).not.toHaveBeenCalled();
    expect(flowRows[0]?.status).toBe('pending');
  });

  it('idempotent: zweiter Lauf reapt nichts mehr', () => {
    const now = 100_000_000;
    flowRows = [
      { id: 'orphan', status: 'pending', updated_at: now - 60 * MIN, ws_status: null },
    ];
    const first = reapOrphanedFlowRuns({ now });
    expect(first.reaped).toEqual(['orphan']);
    __resetFlowRunReapGuardForTests();
    const second = reapOrphanedFlowRuns({ now });
    expect(second.reaped).toEqual([]);
  });

  it('Default-Schwelle = 30min', () => {
    expect(DEFAULT_FLOW_RUN_MAX_AGE_MS).toBe(30 * MIN);
  });
});
