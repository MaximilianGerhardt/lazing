/**
 * Boot-Resume verwaister Iterate-Runs — Tests (Owner-Fix 2026-05-30, Opus 4.8).
 *
 * Testet lib/workstreams/resume-orphans.ts mit In-Memory-Mocks.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/workstreams/__tests__/resume-orphans.test.ts
 *
 * Test-Szenarien (Brief §5):
 *   (a) verwaister Iterate-Run MIT rekonstruierbarem Zwischenstand → runIterateResume aufgerufen
 *   (b) verwaister Run OHNE Zwischenstand (kein iterate, keine Plan-Steps) → sofort stuck + Notify
 *   (c) Idempotenz: zweimal aufgerufen → kein Doppel-Spawn (Claim verhindert es)
 *   (d) laufender (nicht-verwaister) Run → unangetastet
 *       (d1) recent aktiver Sub-WS (Liveness-Guard)
 *       (d2) lebendige tmux-Session
 *   (e) verwaister PLAN-Run (Flow/SOP-Onboarding) mit root-Plan-Steps → executePlan aufgerufen
 *       (e1) Flow-Run: flow_runs zurück auf 'running' + verwaiste 'active'-Steps→'pending'
 *       (e2) SOP-Onboarding-Run: kein flow_runs-Row (no-op), resume trotzdem
 *       (e3) Plan-Run Idempotenz: zweiter Sweep → Claim 0 → kein zweiter executePlan
 *   + isolierter Fehler bricht den Sweep nicht
 *   + concurrent-guard
 *   + kein Secret im Push-Preview
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resumeOrphanedRuns,
  __resetResumeGuardForTests,
  ORPHAN_RESUME_MS,
  ORPHAN_MAX_PER_BOOT,
} from '../resume-orphans';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// SQL-routendes DB-Mock: jede prepare(sql) liefert ein Statement, dessen
// all/get/run aus konfigurierbaren Handlern je nach SQL-Inhalt antwortet.
// ---------------------------------------------------------------------------

interface DbHandlers {
  /** SELECT der Orphan-Kandidaten (status='active' AND updated_at < ?). */
  selectCandidates: () => unknown[];
  /** Liveness-Guard SELECT 1 … parent_workstream_id … status='active'. */
  liveSub: () => unknown;
  /** SELECT tmux_session_id … parent_workstream_id. */
  tmuxRows: () => Array<{ tmux_session_id: string | null }>;
  /** Atomarer Claim UPDATE … SET updated_at … WHERE … updated_at < ?. */
  claim: () => { changes: number };
  /** Terminalisierungs-UPDATE … SET status='stuck'. */
  terminate: () => { changes: number };
  /** flow_runs zurück-auf-'running'-UPDATE (plan-resume). */
  reviveFlowRun: () => { changes: number };
}

const handlers: DbHandlers = {
  selectCandidates: () => [],
  liveSub: () => undefined,
  tmuxRows: () => [],
  claim: () => ({ changes: 1 }),
  terminate: () => ({ changes: 1 }),
  reviveFlowRun: () => ({ changes: 0 }),
};

const dbRaw = {
  prepare: vi.fn<AnyFn>((sql: string) => {
    const s = String(sql);
    return {
      all: vi.fn<AnyFn>(() => {
        if (s.includes('tmux_session_id')) return handlers.tmuxRows();
        if (s.includes("status = 'active'") && s.includes('LIMIT'))
          return handlers.selectCandidates();
        return [];
      }),
      get: vi.fn<AnyFn>(() => {
        // Liveness-Guard: SELECT 1 … parent_workstream_id … updated_at > ?
        return handlers.liveSub();
      }),
      run: vi.fn<AnyFn>(() => {
        if (s.includes("status = 'stuck'")) return handlers.terminate();
        if (s.includes('UPDATE flow_runs')) return handlers.reviveFlowRun();
        // Claim: UPDATE workstreams … SET updated_at = ? WHERE … updated_at < ?
        return handlers.claim();
      }),
    };
  }),
};

vi.mock('@/db/client', () => ({
  getDb: () => ({ $raw: dbRaw }),
}));

const mockWriteDecision = vi.fn<AnyFn>().mockReturnValue('dec_test');
vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (arg: unknown) => mockWriteDecision(arg),
}));

const mockEmitOrUpdateCard = vi
  .fn<AnyFn>()
  .mockResolvedValue({ event: {}, mode: 'inserted' });
vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: (arg: unknown) => mockEmitOrUpdateCard(arg),
}));

const mockEmitAnswerRequired = vi.fn<AnyFn>();
vi.mock('@/lib/push/triggers', () => ({
  emitAnswerRequired: (arg: unknown) => mockEmitAnswerRequired(arg),
}));

// recovery exportiert SUB_ACTIVITY_WINDOW_MS — echtes Modul ist re-import-safe,
// aber wir mocken es zur Isolation (kein DB-Zugriff beim Import).
vi.mock('@/lib/workstreams/recovery', () => ({
  SUB_ACTIVITY_WINDOW_MS: 3 * 60_000,
}));

// tier-orchestrator: loadIterateResumeContext + runIterateResume.
const mockLoadCtx = vi.fn<AnyFn>();
const mockRunIterateResume = vi.fn<AnyFn>().mockResolvedValue({
  workstreamId: 'x',
  resumedFromVersion: 1,
  producedVersion: 2,
  isFinal: false,
  totalCostCents: 0,
  totalDurationMs: 0,
});
vi.mock('@/server/agents/tier-orchestrator', () => ({
  loadIterateResumeContext: (id: string) => mockLoadCtx(id),
  runIterateResume: (id: string) => mockRunIterateResume(id),
}));

// tmux-controller: sessionExists.
const mockSessionExists = vi.fn<AnyFn>().mockResolvedValue(false);
vi.mock('@/server/tmux-controller', () => ({
  sessionExists: (name: string) => mockSessionExists(name),
}));

// plan-repo: listRootPlanSteps (Plan-Run-Klassifikation) + setPlanStepStatus.
const mockListRootPlanSteps = vi.fn<AnyFn>().mockReturnValue([]);
const mockSetPlanStepStatus = vi.fn<AnyFn>();
vi.mock('@/lib/workstreams/plan-repo', () => ({
  listRootPlanSteps: (id: string) => mockListRootPlanSteps(id),
  setPlanStepStatus: (stepId: string, status: string) =>
    mockSetPlanStepStatus(stepId, status),
}));

// plan-executor: executePlan (bestehender, idempotenter Plan-Resume-Pfad).
const mockExecutePlan = vi.fn<AnyFn>().mockResolvedValue(undefined);
vi.mock('@/lib/workstreams/plan-executor', () => ({
  executePlan: (arg: unknown) => mockExecutePlan(arg),
}));

/** Baut eine root-Plan-Step-Row (depth=0) für die Plan-Resume-Tests. */
function makePlanStep(overrides: {
  id?: string;
  status?: string;
  planId?: string;
  coordKey?: string;
} = {}) {
  return {
    id: overrides.id ?? 'STEP-1',
    status: overrides.status ?? 'pending',
    planId: overrides.planId ?? 'PLAN-FLOW-01',
    coordKey: overrides.coordKey ?? 'ws-website/WS-PLAN-01',
    depth: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrphan(overrides: {
  id?: string;
  workspace_id?: string;
  name?: string;
  updated_at?: number;
} = {}) {
  const now = Date.now();
  return {
    id: overrides.id ?? 'WS-ORPHAN-01',
    workspace_id: overrides.workspace_id ?? 'ws-website',
    name: overrides.name ?? 'Erstelle eine Website',
    updated_at: overrides.updated_at ?? now - ORPHAN_RESUME_MS - 60_000,
  };
}

function makeCtx(overrides: { lastVersion?: number; roastCount?: number } = {}) {
  return {
    workspaceId: 'ws-website',
    workspacePath: '/tmp/ws',
    parentTicketId: 'ticket-1',
    originalPrompt: 'Erstelle eine Website',
    lastVersion: overrides.lastVersion ?? 1,
    lastVersionText: 'V1 plan text',
    roastTexts: Array.from({ length: overrides.roastCount ?? 2 }, (_, i) => ({
      roleId: `r${i}`,
      roleLabel: `Roaster ${i}`,
      text: `roast ${i}`,
    })),
  };
}

function resetHandlers() {
  handlers.selectCandidates = () => [];
  handlers.liveSub = () => undefined;
  handlers.tmuxRows = () => [];
  handlers.claim = () => ({ changes: 1 });
  handlers.terminate = () => ({ changes: 1 });
  handlers.reviveFlowRun = () => ({ changes: 0 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resumeOrphanedRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetResumeGuardForTests();
    resetHandlers();
    mockEmitOrUpdateCard.mockResolvedValue({ event: {}, mode: 'inserted' });
    mockSessionExists.mockResolvedValue(false);
    mockListRootPlanSteps.mockReturnValue([]);
    mockExecutePlan.mockResolvedValue(undefined);
    mockRunIterateResume.mockResolvedValue({
      workstreamId: 'x',
      resumedFromVersion: 1,
      producedVersion: 2,
      isFinal: false,
      totalCostCents: 0,
      totalDurationMs: 0,
    });
  });

  afterEach(() => {
    __resetResumeGuardForTests();
  });

  // (a) Orphan MIT Zwischenstand → runIterateResume
  it('(a) verwaister Run mit rekonstruierbarem Zwischenstand → resume-Pfad aufgerufen', async () => {
    const row = makeOrphan();
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined; // kein lebendiger Sub-WS
    mockSessionExists.mockResolvedValue(false); // keine tmux-Session
    handlers.claim = () => ({ changes: 1 }); // Claim erfolgreich
    mockLoadCtx.mockResolvedValue(makeCtx({ lastVersion: 1, roastCount: 2 }));

    const result = await resumeOrphanedRuns();

    expect(result.scanned).toBe(1);
    expect(result.resumed).toEqual([row.id]);
    expect(result.terminated).toHaveLength(0);
    expect(result.errors).toBe(0);

    // Der BESTEHENDE resume-Pfad wurde aufgerufen (N4).
    expect(mockRunIterateResume).toHaveBeenCalledWith(row.id);
    // N8: Decision (resume-Begründung) geschrieben.
    expect(mockWriteDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workstreamId: row.id,
        decisionKind: 'orphan_detected',
        actor: 'policy',
      }),
    );
    // KEINE stuck-Terminalisierung, KEIN Push (es wird ja fortgesetzt).
    const stuckUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdate).toBe(false);
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();
  });

  // (b) Orphan OHNE Zwischenstand → sofort stuck + Notify
  it('(b) verwaister Run ohne Zwischenstand → sofort stuck + Decision + Card + Push (nicht 20min)', async () => {
    const row = makeOrphan({ id: 'WS-NOSTATE' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    handlers.terminate = () => ({ changes: 1 });
    mockLoadCtx.mockResolvedValue(null); // KEIN rekonstruierbarer Zwischenstand

    const result = await resumeOrphanedRuns();

    expect(result.terminated).toEqual(['WS-NOSTATE']);
    expect(result.resumed).toHaveLength(0);

    // runIterateResume wurde NICHT aufgerufen (kein Schein-Resume).
    expect(mockRunIterateResume).not.toHaveBeenCalled();

    // Sofort auf stuck terminalisiert.
    const stuckUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdate).toBe(true);

    // N8 + Card + Push.
    expect(mockWriteDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decisionKind: 'orphan_detected' }),
    );
    expect(mockEmitOrUpdateCard).toHaveBeenCalledWith(
      expect.objectContaining({
        coords: expect.objectContaining({ surfaceKind: 'toast' }),
      }),
    );
    expect(mockEmitAnswerRequired).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'WS-NOSTATE', kind: 'run-stuck' }),
    );
  });

  // (c) Idempotenz: Claim verhindert Doppel-Spawn
  it('(c) Idempotenz: Claim changes=0 → kein runIterateResume, kein stuck (anderer Lauf war schneller)', async () => {
    const row = makeOrphan({ id: 'WS-CLAIMED' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    // Claim schlägt fehl → ein paralleler/zweiter Boot hat den Run schon gegriffen.
    handlers.claim = () => ({ changes: 0 });
    mockLoadCtx.mockResolvedValue(makeCtx());

    const result = await resumeOrphanedRuns();

    expect(result.resumed).toHaveLength(0);
    expect(result.terminated).toHaveLength(0);
    expect(result.results[0]?.outcome).toBe('claim-lost');

    // KEIN Spawn, KEIN loadCtx, KEINE stuck-Terminalisierung.
    expect(mockRunIterateResume).not.toHaveBeenCalled();
    expect(mockLoadCtx).not.toHaveBeenCalled();
    const stuckUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdate).toBe(false);
  });

  // (c2) Idempotenz end-to-end: zwei Sweeps hintereinander, zweiter Claim ist 0
  it('(c2) zweiter Sweep direkt danach → Claim 0 → kein zweiter Spawn', async () => {
    const row = makeOrphan({ id: 'WS-TWICE' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    mockLoadCtx.mockResolvedValue(makeCtx());

    let claimCalls = 0;
    handlers.claim = () => {
      claimCalls += 1;
      return { changes: claimCalls === 1 ? 1 : 0 }; // 1. greift, 2. nicht
    };

    const r1 = await resumeOrphanedRuns();
    const r2 = await resumeOrphanedRuns();

    expect(r1.resumed).toEqual(['WS-TWICE']);
    expect(r2.resumed).toHaveLength(0);
    // Genau EIN Spawn über beide Sweeps.
    expect(mockRunIterateResume).toHaveBeenCalledTimes(1);
  });

  // (d1) lebendiger Run via Liveness-Guard → unangetastet
  it('(d1) laufender Run (recent aktiver Sub-WS) → alive, kein Spawn/Claim/stuck', async () => {
    const row = makeOrphan({ id: 'WS-LIVE-SUB' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => ({ 1: 1 }); // recent aktiver Sub-WS

    const result = await resumeOrphanedRuns();

    expect(result.aliveSkipped).toBe(1);
    expect(result.resumed).toHaveLength(0);
    expect(result.terminated).toHaveLength(0);
    expect(result.results[0]?.outcome).toBe('alive');

    expect(mockRunIterateResume).not.toHaveBeenCalled();
    expect(mockLoadCtx).not.toHaveBeenCalled();
    // Kein Claim-UPDATE und kein stuck-UPDATE.
    const anyUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE workstreams'),
    );
    expect(anyUpdate).toBe(false);
  });

  // (d2) lebendige tmux-Session → unangetastet (R3 konservativ)
  it('(d2) laufender Run (lebendige tmux-Session) → alive, kein Spawn', async () => {
    const row = makeOrphan({ id: 'WS-LIVE-TMUX' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined; // kein recent Sub-WS …
    handlers.tmuxRows = () => [{ tmux_session_id: 'lazyos-spawn-WS-LIVE-TMUX-opus-1' }];
    mockSessionExists.mockResolvedValue(true); // … aber tmux lebt noch

    const result = await resumeOrphanedRuns();

    expect(result.aliveSkipped).toBe(1);
    expect(result.results[0]?.outcome).toBe('alive');
    expect(result.results[0]?.detail).toBe('live-tmux-session');
    expect(mockRunIterateResume).not.toHaveBeenCalled();
    // tmux wurde tatsächlich geprobt.
    expect(mockSessionExists).toHaveBeenCalledWith(
      'lazyos-spawn-WS-LIVE-TMUX-opus-1',
    );
    // KEIN Claim/stuck.
    const anyUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE workstreams'),
    );
    expect(anyUpdate).toBe(false);
  });

  // (d3) tote tmux-Session (Name vorhanden, aber Session weg) → resume läuft weiter
  it('(d3) tote tmux-Session (Name da, Session weg) blockiert resume NICHT', async () => {
    const row = makeOrphan({ id: 'WS-DEAD-TMUX' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    handlers.tmuxRows = () => [{ tmux_session_id: 'lazyos-spawn-dead' }];
    mockSessionExists.mockResolvedValue(false); // Session existiert nicht mehr
    handlers.claim = () => ({ changes: 1 });
    mockLoadCtx.mockResolvedValue(makeCtx());

    const result = await resumeOrphanedRuns();

    expect(result.resumed).toEqual(['WS-DEAD-TMUX']);
    expect(mockRunIterateResume).toHaveBeenCalledWith('WS-DEAD-TMUX');
  });

  // (e1) verwaister FLOW-Run mit Plan-Steps → executePlan + flow_runs→running
  it('(e1) verwaister Flow-Run (Plan-Steps, kein iterate) → executePlan + active→pending + flow_runs→running', async () => {
    const row = makeOrphan({ id: 'WS-PLAN-01', workspace_id: 'ws-website' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    // KEIN iterate-Zwischenstand …
    mockLoadCtx.mockResolvedValue(null);
    // … aber root-Plan-Steps: 1 done, 1 verwaist-active, 1 pending.
    mockListRootPlanSteps.mockReturnValue([
      makePlanStep({ id: 'STEP-1', status: 'done' }),
      makePlanStep({ id: 'STEP-2', status: 'active' }),
      makePlanStep({ id: 'STEP-3', status: 'pending' }),
    ]);
    // flow_runs-Row existiert → revive matcht.
    handlers.reviveFlowRun = () => ({ changes: 1 });

    const result = await resumeOrphanedRuns();

    expect(result.resumed).toEqual(['WS-PLAN-01']);
    expect(result.terminated).toHaveLength(0);
    expect(result.results[0]?.resumedKind).toBe('plan');

    // Der BESTEHENDE Plan-Resume-Pfad (N4) — mit planId/coordKey aus den Steps.
    expect(mockExecutePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        workstreamId: 'WS-PLAN-01',
        workspaceId: 'ws-website',
        planId: 'PLAN-FLOW-01',
        coordKey: 'ws-website/WS-PLAN-01',
      }),
    );
    // KEIN iterate-Resume (falscher Pfad).
    expect(mockRunIterateResume).not.toHaveBeenCalled();
    // Der verwaiste 'active'-Step wurde auf 'pending' zurückgesetzt (re-fahrbar).
    expect(mockSetPlanStepStatus).toHaveBeenCalledWith('STEP-2', 'pending');
    // done-Step NICHT angefasst (R3 — wird nie re-spawnt).
    expect(mockSetPlanStepStatus).not.toHaveBeenCalledWith('STEP-1', 'pending');
    // flow_runs zurück auf 'running' (UI-Konsistenz).
    const flowRunUpdate = dbRaw.prepare.mock.calls.some(
      (c) =>
        typeof c[0] === 'string' && (c[0] as string).includes('UPDATE flow_runs'),
    );
    expect(flowRunUpdate).toBe(true);
    // N8-Decision mit plan-Begründung.
    expect(mockWriteDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        workstreamId: 'WS-PLAN-01',
        decisionKind: 'orphan_detected',
        actor: 'policy',
      }),
    );
    // KEINE Terminalisierung (es wird fortgesetzt).
    const stuckUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdate).toBe(false);
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();
  });

  // (e2) verwaister SOP-Onboarding-Run (Plan-Steps, KEIN flow_runs-Row) → resume
  it('(e2) verwaister SOP-Onboarding-Run (Plan-Steps, kein flow_runs-Row) → executePlan, flow-revive no-op', async () => {
    const row = makeOrphan({ id: 'WS-SOP-01', workspace_id: 'ws-crm' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    mockLoadCtx.mockResolvedValue(null);
    mockListRootPlanSteps.mockReturnValue([
      makePlanStep({ id: 'STEP-A', status: 'pending', planId: 'PLAN-SOP', coordKey: 'ws-crm/WS-SOP-01' }),
      makePlanStep({ id: 'STEP-B', status: 'pending', planId: 'PLAN-SOP', coordKey: 'ws-crm/WS-SOP-01' }),
    ]);
    // KEIN flow_runs-Row → revive matcht nichts (changes=0). resume läuft trotzdem.
    handlers.reviveFlowRun = () => ({ changes: 0 });

    const result = await resumeOrphanedRuns();

    expect(result.resumed).toEqual(['WS-SOP-01']);
    expect(result.results[0]?.resumedKind).toBe('plan');
    expect(mockExecutePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        workstreamId: 'WS-SOP-01',
        planId: 'PLAN-SOP',
        coordKey: 'ws-crm/WS-SOP-01',
      }),
    );
    // Keine verwaisten active-Steps → kein Reset.
    expect(mockSetPlanStepStatus).not.toHaveBeenCalled();
    // Nicht terminalisiert.
    const stuckUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdate).toBe(false);
  });

  // (e3) Plan-Run Idempotenz: zweiter Sweep → Claim 0 → kein zweiter executePlan
  it('(e3) Plan-Run Idempotenz: zwei Sweeps → genau EIN executePlan (Claim schützt)', async () => {
    const row = makeOrphan({ id: 'WS-PLAN-TWICE' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    mockLoadCtx.mockResolvedValue(null);
    mockListRootPlanSteps.mockReturnValue([
      makePlanStep({ id: 'STEP-X', status: 'pending' }),
    ]);

    let claimCalls = 0;
    handlers.claim = () => {
      claimCalls += 1;
      return { changes: claimCalls === 1 ? 1 : 0 };
    };

    const r1 = await resumeOrphanedRuns();
    const r2 = await resumeOrphanedRuns();

    expect(r1.resumed).toEqual(['WS-PLAN-TWICE']);
    expect(r2.resumed).toHaveLength(0);
    expect(r2.results[0]?.outcome).toBe('claim-lost');
    expect(mockExecutePlan).toHaveBeenCalledTimes(1);
  });

  // (e4) kein iterate UND keine Plan-Steps → terminalisiert (kein Schein-Resume)
  it('(e4) kein iterate-Ctx UND keine Plan-Steps → terminalisiert (kein executePlan)', async () => {
    const row = makeOrphan({ id: 'WS-EMPTY' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    handlers.terminate = () => ({ changes: 1 });
    mockLoadCtx.mockResolvedValue(null);
    mockListRootPlanSteps.mockReturnValue([]); // keine Plan-Steps

    const result = await resumeOrphanedRuns();

    expect(result.terminated).toEqual(['WS-EMPTY']);
    expect(result.resumed).toHaveLength(0);
    expect(mockExecutePlan).not.toHaveBeenCalled();
    expect(mockRunIterateResume).not.toHaveBeenCalled();
    const stuckUpdate = dbRaw.prepare.mock.calls.some(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'stuck'"),
    );
    expect(stuckUpdate).toBe(true);
    expect(mockEmitAnswerRequired).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'WS-EMPTY', kind: 'run-stuck' }),
    );
  });

  // Kein Kandidat → no-op
  it('keine Orphan-Kandidaten → no-op, keine Mutationen', async () => {
    handlers.selectCandidates = () => [];

    const result = await resumeOrphanedRuns();

    expect(result.scanned).toBe(0);
    expect(result.resumed).toHaveLength(0);
    expect(result.terminated).toHaveLength(0);
    expect(mockRunIterateResume).not.toHaveBeenCalled();
    expect(mockWriteDecision).not.toHaveBeenCalled();
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();
  });

  // Isolierter Fehler bricht den Sweep nicht
  it('ein Fehler bei einem Run bricht den Sweep für andere nicht', async () => {
    const rows = [
      makeOrphan({ id: 'WS-THROWS', workspace_id: 'ws-a' }),
      makeOrphan({ id: 'WS-GOOD', workspace_id: 'ws-b' }),
    ];
    handlers.selectCandidates = () => rows;
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    // erster loadCtx wirft, zweiter liefert Kontext
    let calls = 0;
    mockLoadCtx.mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error('DB-Fehler beim ersten Run');
      return Promise.resolve(makeCtx());
    });

    const result = await resumeOrphanedRuns();

    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.resumed).toEqual(['WS-GOOD']);
  });

  // Concurrent-Guard
  it('concurrent guard: nach erfolgreichem Sweep ist der Guard zurückgesetzt', async () => {
    handlers.selectCandidates = () => [];
    const r1 = await resumeOrphanedRuns();
    expect(r1.skippedDueToConcurrentSweep).toBe(false);
    const r2 = await resumeOrphanedRuns();
    expect(r2.skippedDueToConcurrentSweep).toBe(false);
  });

  // Kein Secret im Push-Preview
  it('Push-Preview enthält kein langes Secret (≤100 Zeichen, gekürzter Name)', async () => {
    const row = makeOrphan({
      id: 'WS-SECRET',
      name: 'sk-ANTHROPIC-SUPER-SECRET-KEY-0123456789-0123456789-0123456789',
    });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    handlers.terminate = () => ({ changes: 1 });
    mockLoadCtx.mockResolvedValue(null); // → Terminalisierung mit Push

    await resumeOrphanedRuns();

    const pushArg = mockEmitAnswerRequired.mock.calls[0]?.[0] as
      | { preview?: string }
      | undefined;
    expect(pushArg).toBeDefined();
    expect(typeof pushArg?.preview).toBe('string');
    expect((pushArg?.preview as string).length).toBeLessThanOrEqual(100);
  });

  // Terminate-Race: changes=0 → kein Push (Status schon geändert)
  it('Terminalisierungs-Race (changes=0) → kein Decision/Card/Push', async () => {
    const row = makeOrphan({ id: 'WS-RACE' });
    handlers.selectCandidates = () => [row];
    handlers.liveSub = () => undefined;
    mockSessionExists.mockResolvedValue(false);
    handlers.claim = () => ({ changes: 1 });
    handlers.terminate = () => ({ changes: 0 }); // Race: schon geändert
    mockLoadCtx.mockResolvedValue(null);

    const result = await resumeOrphanedRuns();

    // outcome ist trotzdem 'terminated' (wir haben es versucht), aber keine
    // Side-Effects nach dem Race.
    expect(mockWriteDecision).not.toHaveBeenCalled();
    expect(mockEmitOrUpdateCard).not.toHaveBeenCalled();
    expect(mockEmitAnswerRequired).not.toHaveBeenCalled();
    expect(result.errors).toBe(0);
  });

  // Sanity: Konstanten
  it('ORPHAN_RESUME_MS sane default (1min..60min)', () => {
    expect(ORPHAN_RESUME_MS).toBeGreaterThanOrEqual(60_000);
    expect(ORPHAN_RESUME_MS).toBeLessThanOrEqual(60 * 60_000);
  });
  it('ORPHAN_MAX_PER_BOOT zwischen 1 und 100', () => {
    expect(ORPHAN_MAX_PER_BOOT).toBeGreaterThanOrEqual(1);
    expect(ORPHAN_MAX_PER_BOOT).toBeLessThanOrEqual(100);
  });
});
