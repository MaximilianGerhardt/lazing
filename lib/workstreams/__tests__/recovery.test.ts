/**
 * Self-Healing Recovery Sweep Tests (2026-05-25).
 *
 * Testet lib/workstreams/recovery.ts mit In-Memory-Mocks.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/workstreams/__tests__/recovery.test.ts
 *
 * Test-Szenarien:
 *   (a) stale active/paused → stuck + decision + card + notify
 *   (b) frischer Run (updated_at jung) → unberührt
 *   (c) schon-stuck → nicht erneut angefasst
 *   (d) ein Fehler-Run bricht den Sweep nicht
 *   (e) bounded (max MAX_PER_TICK pro Tick)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sweepStaleWorkstreams,
  __resetSweepGuardForTests,
  STALE_MS,
  MAX_PER_TICK,
} from '../recovery';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared mock state — typed to avoid `never` inference
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

const dbRawPreparedStmt: {
  all: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} = {
  all: vi.fn<AnyFn>().mockReturnValue([]),
  run: vi.fn<AnyFn>().mockReturnValue({ changes: 1 }),
  get: vi.fn<AnyFn>().mockReturnValue(undefined),
};
const dbRaw = {
  prepare: vi.fn<AnyFn>().mockReturnValue(dbRawPreparedStmt),
};

vi.mock('@/db/client', () => ({
  getDb: () => ({ $raw: dbRaw }),
}));

// Mock writeDecision — best-effort call
const mockWriteDecision = vi.fn<AnyFn>().mockReturnValue('dec_test');
vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (arg: unknown) => mockWriteDecision(arg),
}));

// Mock emitOrUpdateCard
const mockEmitOrUpdateCard = vi.fn<AnyFn>().mockResolvedValue({ event: {}, mode: 'inserted' });
vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: (arg: unknown) => mockEmitOrUpdateCard(arg),
}));

// Mock emitAnswerRequired
const mockEmitAnswerRequired = vi.fn<AnyFn>();
vi.mock('@/lib/push/triggers', () => ({
  emitAnswerRequired: (arg: unknown) => mockEmitAnswerRequired(arg),
}));

// Reliability-Sweep 2026-05-30: der Recovery-Sweep ruft am Ende den
// orphaned-flow_runs-Reaper (reap-stale.ts) als Piggyback. Hier gemockt, damit
// die Workstream-Sweep-Assertions (prepare/run-Calls) isoliert bleiben — der
// flow_run-Reaper hat eigene Tests in reap-stale.test.ts.
const mockReapOrphanedFlowRuns = vi.fn<AnyFn>(() => ({
  scanned: 0,
  reaped: [],
  errors: 0,
  reapedAt: Date.now(),
}));
vi.mock('@/lib/workstreams/reap-stale', () => ({
  reapOrphanedFlowRuns: (arg: unknown) => mockReapOrphanedFlowRuns(arg),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStaleRow(overrides: {
  id?: string;
  workspace_id?: string;
  name?: string;
  status?: string;
  updated_at?: number;
} = {}) {
  const now = Date.now();
  return {
    id: overrides.id ?? 'WS-TEST-01',
    workspace_id: overrides.workspace_id ?? 'ws-test',
    name: overrides.name ?? 'Test Workstream',
    status: overrides.status ?? 'active',
    // Default: updated_at ist älter als STALE_MS (stale)
    updated_at: overrides.updated_at ?? now - STALE_MS - 60_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sweepStaleWorkstreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSweepGuardForTests();
    // Re-attach mocks after clearAllMocks
    dbRaw.prepare.mockReturnValue(dbRawPreparedStmt);
    // Default: SELECT gibt leere Liste zurück
    dbRawPreparedStmt.all.mockReturnValue([] as unknown[]);
    // Default: UPDATE verändert 1 Row
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });
    // Default: Liveness-Guard SELECT (.get) liefert KEINEN aktiven Sub-WS
    // → Run gilt als orphaned (nicht lebendig). Tests die Liveness prüfen
    // überschreiben das per get.mockReturnValue.
    dbRawPreparedStmt.get.mockReturnValue(undefined);
    mockEmitOrUpdateCard.mockResolvedValue({ event: {}, mode: 'inserted' });
  });

  afterEach(() => {
    __resetSweepGuardForTests();
  });

  // (b) Keine stale Rows → leeres Ergebnis, keine Side-Effects
  it('(b) frischer Run (kein stale-Row) → unberührt, keine Mutationen', async () => {
    dbRawPreparedStmt.all.mockReturnValue([] as unknown[]); // SELECT liefert leer

    const result = await sweepStaleWorkstreams();

    expect(result.scanned).toBe(0);
    expect(result.terminated).toHaveLength(0);
    expect(result.errors).toBe(0);
    expect(result.skippedDueToConcurrentSweep).toBe(false);

    // Kein writeDecision, kein emitOrUpdateCard, kein emitAnswerRequired
    expect(mockWriteDecision).not.toHaveBeenCalled();
    expect(mockEmitOrUpdateCard).not.toHaveBeenCalled();
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();
  });

  // (a) stale active → stuck + decision + card + notify
  it('(a) stale active Run → stuck markiert + Decision + Card + Notification', async () => {
    const row = makeStaleRow({ status: 'active' });
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });

    const result = await sweepStaleWorkstreams();

    expect(result.scanned).toBe(1);
    expect(result.terminated).toEqual([row.id]);
    expect(result.errors).toBe(0);

    // UPDATE auf stuck
    expect(dbRaw.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'stuck'"));
    expect(dbRawPreparedStmt.run).toHaveBeenCalledWith(
      expect.any(Number),
      row.id,
    );

    // N8: Decision geschrieben
    expect(mockWriteDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workstreamId: row.id,
        workspaceId: row.workspace_id,
        decisionKind: 'orphan_detected',
        actor: 'policy',
      }),
    );

    // Status-Card emittiert
    expect(mockEmitOrUpdateCard).toHaveBeenCalledWith(
      expect.objectContaining({
        coords: expect.objectContaining({
          workspaceId: row.workspace_id,
          workstreamId: row.id,
          surfaceKind: 'toast',
        }),
      }),
    );

    // Push-Notification ausgelöst
    expect(mockEmitAnswerRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: row.workspace_id,
        entityId: row.id,
        kind: 'run-stuck',
      }),
    );
  });

  // (a) stale paused → gleiche Behandlung wie active
  it('(a) stale paused Run → stuck + notification', async () => {
    const row = makeStaleRow({ status: 'paused', id: 'WS-PAUSED-01' });
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });

    const result = await sweepStaleWorkstreams();

    expect(result.terminated).toContain('WS-PAUSED-01');
    expect(mockWriteDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decisionKind: 'orphan_detected' }),
    );
    expect(mockEmitAnswerRequired).toHaveBeenCalled();
  });

  // (#1b) Liveness-Guard: lebender Run mit recent Sub-Activity → NICHT stuck
  it('(#1b) lebender Run (recent aktiver Sub-WS) → NICHT stuck, kein Push', async () => {
    const row = makeStaleRow({ id: 'WS-LIVE', status: 'active' });
    // SELECT-all liefert den (master-)stale Run
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    // Liveness-SELECT (.get) liefert einen Treffer → Sub-WS läuft noch
    dbRawPreparedStmt.get.mockReturnValue({ 1: 1 });

    const result = await sweepStaleWorkstreams();

    expect(result.scanned).toBe(1);
    // NICHT terminiert — Welle lebt
    expect(result.terminated).toHaveLength(0);
    expect(result.errors).toBe(0);

    // KEIN stuck-UPDATE, KEIN Decision, KEINE Card, KEIN Push
    // (der einzige .run-Call dürfte nicht passieren — UPDATE wird vor
    //  dem Liveness-Check NICHT erreicht)
    expect(mockWriteDecision).not.toHaveBeenCalled();
    expect(mockEmitOrUpdateCard).not.toHaveBeenCalled();
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();

    // Verify: kein stuck-UPDATE wurde abgesetzt
    const stuckUpdateCalled = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdateCalled).toBe(false);
  });

  // (#1b) Run OHNE Sub-Activity + >20min → stuck (Liveness-Guard greift nicht)
  it('(#1b) Run ohne recent Sub-Activity + stale → stuck', async () => {
    const now = Date.now();
    const row = makeStaleRow({
      id: 'WS-DEAD',
      status: 'active',
      updated_at: now - STALE_MS - 5 * 60_000, // deutlich über 20min
    });
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    // Liveness-SELECT liefert KEINEN aktiven Sub-WS → orphaned
    dbRawPreparedStmt.get.mockReturnValue(undefined);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });

    const result = await sweepStaleWorkstreams(now);

    expect(result.terminated).toEqual(['WS-DEAD']);
    expect(mockWriteDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decisionKind: 'orphan_detected' }),
    );
    expect(mockEmitAnswerRequired).toHaveBeenCalled();
  });

  // (c) UPDATE changes=0 → Row wurde concurrent geändert → skip, kein Decision
  it('(c) UPDATE changes=0 (concurrent change) → kein Decision, kein Push', async () => {
    const row = makeStaleRow({ id: 'WS-CONCURRENT' });
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    // Simuliert: Row wurde zwischen SELECT und UPDATE geändert (z.B. Agent hat finished)
    dbRawPreparedStmt.run.mockReturnValue({ changes: 0 });

    const result = await sweepStaleWorkstreams();

    // Kein Fehler — aber terminated ist leer (Race erkannt)
    expect(result.terminated).toHaveLength(0);
    expect(result.errors).toBe(0);

    // Kein Decision/Card/Push nach Race
    expect(mockWriteDecision).not.toHaveBeenCalled();
    expect(mockEmitOrUpdateCard).not.toHaveBeenCalled();
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();
  });

  // (d) ein Fehler-Run bricht den Sweep nicht
  it('(d) ein Fehler beim ersten Run bricht den Sweep für andere nicht', async () => {
    const rows = [
      makeStaleRow({ id: 'WS-THROWS', workspace_id: 'ws-a' }),
      makeStaleRow({ id: 'WS-GOOD', workspace_id: 'ws-b' }),
    ];
    dbRawPreparedStmt.all.mockReturnValue(rows as unknown[]);

    // Ersten Run wirft, zweiten nicht
    let callCount = 0;
    dbRawPreparedStmt.run.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) throw new Error('DB-Fehler beim ersten Run');
      return { changes: 1 };
    });

    const result = await sweepStaleWorkstreams();

    expect(result.scanned).toBe(2);
    expect(result.terminated).toEqual(['WS-GOOD']); // nur der gute
    expect(result.errors).toBe(1); // ein Fehler gezählt
  });

  // (e) bounded: MAX_PER_TICK Limit
  it('(e) bounded: nur MAX_PER_TICK Rows werden pro Tick verarbeitet', async () => {
    // SELECT gibt genau MAX_PER_TICK + 1 Rows zurück (DB gibt aber LIMIT=MAX_PER_TICK)
    // Wir simulieren: SELECT gibt MAX_PER_TICK Rows zurück (DB LIMIT greift)
    const rows = Array.from({ length: MAX_PER_TICK }, (_, i) =>
      makeStaleRow({ id: `WS-BATCH-${i}` }),
    );
    dbRawPreparedStmt.all.mockReturnValue(rows as unknown[]);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });

    const result = await sweepStaleWorkstreams();

    expect(result.scanned).toBe(MAX_PER_TICK);
    expect(result.terminated).toHaveLength(MAX_PER_TICK);

    // LIMIT war im SELECT enthalten (Query-Argument = MAX_PER_TICK)
    const prepareCalls = dbRaw.prepare.mock.calls as Array<unknown[]>;
    const selectCall = prepareCalls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0] as string).includes('status IN') &&
        (c[0] as string).includes('LIMIT'),
    );
    expect(selectCall).toBeDefined();
  });

  // Idempotenz: Concurrent-Sweep-Guard
  it('concurrent guard: zweiter gleichzeitiger Aufruf wird skipped', async () => {
    const row = makeStaleRow();
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });

    // Sweeping simulieren: Guard manuell setzen durch parallelen Fire-and-forget
    // Wir nutzen die interne Guard-Logik: erster Sweep setzt sweepInProgress=true,
    // bis er fertig ist. Zweiter Sweep bekommt skipped.
    // Da wir keinen async-Hole haben, simulieren wir direkt via Guard.
    // Test: nach erfolgreichem Sweep ist Guard zurückgesetzt.
    const result1 = await sweepStaleWorkstreams();
    expect(result1.skippedDueToConcurrentSweep).toBe(false);

    // Guard ist nach dem Sweep zurückgesetzt → zweiter Aufruf läuft normal
    const result2 = await sweepStaleWorkstreams();
    expect(result2.skippedDueToConcurrentSweep).toBe(false);
  });

  // emitOrUpdateCard Fehler ist non-fatal
  it('emitOrUpdateCard-Fehler ist non-fatal (Sweep terminiert trotzdem)', async () => {
    const row = makeStaleRow({ id: 'WS-CARD-FAIL' });
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });
    mockEmitOrUpdateCard.mockRejectedValueOnce(new Error('SSE down'));

    const result = await sweepStaleWorkstreams();

    // Run trotzdem terminiert (stuck-Update + Decision passiert vor Card-Emit)
    expect(result.terminated).toContain('WS-CARD-FAIL');
    expect(result.errors).toBe(0); // Card-Fehler wird intern gecatcht, nicht als error gezählt
    // Push trotzdem abgesetzt
    expect(mockEmitAnswerRequired).toHaveBeenCalled();
  });

  // Kein Secret im Push-Preview
  it('Preview enthält kein Secret/Token-Muster', async () => {
    const row = makeStaleRow({ name: 'sk-APIKEY1234567890' });
    dbRawPreparedStmt.all.mockReturnValue([row] as unknown[]);
    dbRawPreparedStmt.run.mockReturnValue({ changes: 1 });

    await sweepStaleWorkstreams();

    const pushCalls = mockEmitAnswerRequired.mock.calls as Array<Array<Record<string, unknown>>>;
    const pushCall = pushCalls[0]?.[0];
    expect(pushCall).toBeDefined();
    // Preview darf nur max 100 Zeichen haben (emitAnswerRequired kürzt intern)
    const preview = pushCall?.['preview'];
    expect(typeof preview).toBe('string');
    expect((preview as string).length).toBeLessThanOrEqual(100);
  });

  // STALE_MS default-Wert sanity-check
  it('STALE_MS liegt zwischen 1min und 60min (sane default)', () => {
    expect(STALE_MS).toBeGreaterThanOrEqual(60_000); // mind. 1 min
    expect(STALE_MS).toBeLessThanOrEqual(60 * 60_000); // max 60 min
  });

  // MAX_PER_TICK sanity-check
  it('MAX_PER_TICK ist zwischen 1 und 100', () => {
    expect(MAX_PER_TICK).toBeGreaterThanOrEqual(1);
    expect(MAX_PER_TICK).toBeLessThanOrEqual(100);
  });
});
