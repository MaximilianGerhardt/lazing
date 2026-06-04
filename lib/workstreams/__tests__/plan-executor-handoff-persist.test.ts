/**
 * lib/workstreams/__tests__/plan-executor-handoff-persist.test.ts
 * ----------------------------------------------------------------
 * Self-Learning Enhancements · Stream E5 · E5.1 (2026-05-27).
 *
 * BEFUND (Research): persistWorkspaceHandoff (lib/reasoning/auto-handoff.ts) ist
 * gebaut+getestet, hatte aber KEINEN Aufrufer → der UI-sichtbare Workspace-
 * Handoff in workspaces.notes wurde nie geschrieben. E5.1 verdrahtet ihn in den
 * Done-Hook des plan-executor — DIREKT nach dem A5-Reconcile, im EIGENEN fail-
 * soft try/catch (ein Fehler darf den Run-Abschluss NIE kippen).
 *
 * Diese Tests fahren den ECHTEN executePlan-Done-Hook gegen eine ECHTE in-memory
 * better-sqlite3-DB (Schema aus den echten Migrationen, exakt wie der auto-
 * handoff-Unit-Test). Damit läuft die volle buildWorkspaceHandoff →
 * persistWorkspaceHandoff-Kette gegen reales SQL. Die IO-Ränder (engine, tmux-
 * spawn, worktree, resource-pool, emit, plan-repo, reconcile) sind gemockt — wir
 * prüfen NUR die Handoff-Verdrahtung im Done-Hook, nicht die Parallel-/Flow-
 * Graph-Logik.
 *
 * Deckt ab:
 *   (1) Nach Run-Abschluss steht eine ai-summary in workspaces.notes (DB mit
 *       Decisions/Beliefs → Handoff nicht leer → notes_source='ai-summary').
 *   (2) Eine 'manual'-Note bleibt UNANGETASTET (REPLACE-Schutz greift).
 *   (3) Ein Fehler im Handoff-Persist kippt den Run-Abschluss NICHT (Done-Hook
 *       läuft durch, Abschluss-Card wird trotzdem emittiert).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/workstreams/__tests__/plan-executor-handoff-persist.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted shared state ─────────────────────────────────────────────────────

const H = vi.hoisted(() => ({
  WORKSPACE_ID: 'wsp-handoff-001',
  WORKSTREAM_ID: 'WS-handoff-001',
  PLAN_ID: 'PLN-handoff-001',
  // Real in-memory DB (per-Test frisch) — von der @/db/client-Mock zurückgegeben.
  db: null as null | { $raw: import('better-sqlite3').Database },
  listRootPlanSteps: vi.fn(),
  setPlanStepStatus: vi.fn(),
  engineChat: vi.fn(),
  emitCompleted: vi.fn(),
}));

// ── Mock: plan-repo ──────────────────────────────────────────────────────────

vi.mock('@/lib/workstreams/plan-repo', () => ({
  listRootPlanSteps: (...a: unknown[]) => H.listRootPlanSteps(...a),
  setPlanStepStatus: (...a: unknown[]) => H.setPlanStepStatus(...a),
}));

// ── Mock: engine selector — text-only path (default-safe, kein Spawn) ────────

vi.mock('@/lib/llm/engines/selector', () => ({
  detectEngines: vi
    .fn()
    .mockResolvedValue({ available: [{ engine: 'claude-cli', available: true }] }),
  pickEngine: () => ({ id: 'claude-cli', chat: H.engineChat }),
}));

// ── Mock: resource-pool / budget ─────────────────────────────────────────────

vi.mock('@/lib/agents/resource-pool', () => ({
  resourcePool: {
    acquireSlot: vi.fn().mockResolvedValue({ slotId: 'slot-1' }),
    releaseSlot: vi.fn(),
    getBudget: vi.fn().mockReturnValue({ heavyTotal: 2, perKind: { 'ollama-heavy': 1 } }),
    getConcurrencyBudget: vi
      .fn()
      .mockReturnValue({ heavyOllama: 2, spawnConcurrency: 5, textConcurrency: 6 }),
  },
}));

vi.mock('@/lib/agents/tpm-budget', () => ({
  waitForBudget: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock: card/emit edges ────────────────────────────────────────────────────

vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/events/emit', () => ({
  emitChatMessageCompleted: (...a: unknown[]) => H.emitCompleted(...a),
}));
vi.mock('@/lib/ulid', () => ({ ulid: () => 'ULID-mock' }));

// ── Mock: workstream service (lazy import) ───────────────────────────────────

vi.mock('@/lib/workstreams/service', () => ({
  getWorkstream: vi.fn().mockResolvedValue({ name: 'Handoff-WS', description: 'handoff test' }),
}));

// ── Mock: db/client — liefert die ECHTE in-memory DB (real $raw) ─────────────
//
// Das ist der Kern: reconcileWorkstream UND der neue Handoff-Persist greifen
// beide auf getDb().$raw zu. Wir geben ihnen eine ECHTE better-sqlite3-DB, damit
// buildWorkspaceHandoff/persistWorkspaceHandoff gegen reales SQL laufen.

vi.mock('@/db/client', () => ({
  getDb: () => H.db,
}));

// ── Mock: workspaces — resolveWorkspacePath (nur plan-only-Pfad genutzt) ─────

vi.mock('@/lib/workspaces', () => ({
  getWorkspace: vi.fn().mockResolvedValue({ path: '/fake/repo/path' }),
}));

// ── Mock: worktree-manager / tmux-spawn / trace-repo — im plan-only-Pfad ungenutzt ─

vi.mock('@/lib/agents/worktree-manager', () => ({
  createOrReuseRunWorktree: vi.fn().mockResolvedValue({ runBranch: 'lazing/run/r' }),
  createStepWorktree: vi.fn().mockResolvedValue({ worktreePath: '/fake/wt', stepBranch: 'lazing/step/s' }),
  mergeStepIntoRun: vi.fn().mockResolvedValue({ merged: true }),
  discardStepWorktree: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/agents/tmux-spawn', () => ({
  spawnInTmux: vi.fn().mockResolvedValue({
    text: 'x',
    tokens: { input: 1, output: 1, cacheRead: 0 },
    costCents: 0,
    durationMs: 1,
    exitCode: 0,
    rateLimited: false,
    timedOut: false,
  }),
}));
vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: vi.fn().mockReturnValue('dec_mock'),
}));

// ── Mock: reconcile — no-op, damit der A5-Block den Handoff nicht beeinflusst ─

vi.mock('@/lib/reasoning/reconcile', () => ({
  reconcileWorkstream: vi.fn().mockReturnValue({
    outcome: 'success',
    alreadyReconciled: false,
    beliefUpdates: 0,
    drifts: [],
    unjustified: [],
    whyQuestion: null,
  }),
}));

// ── DB-Fixture (Schema aus echten Migrationen, wie auto-handoff-Unit-Test) ────

const MIG = (name: string): string => path.join(process.cwd(), 'db', 'migrations', name);

function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  raw.exec(readFileSync(MIG('0009_workstreams.sql'), 'utf8'));
  raw.exec(readFileSync(MIG('0071_workstream_decisions.sql'), 'utf8'));
  raw.exec(readFileSync(MIG('0113_workspace_beliefs.sql'), 'utf8'));
  // Minimale workspaces-Tabelle (Shape wie 0002 + 0013, nur Handoff-relevante Spalten).
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id               TEXT PRIMARY KEY NOT NULL,
      notes            TEXT,
      notes_updated_at INTEGER,
      notes_source     TEXT
    );
  `);
  return raw;
}

function seedWorkspaceWithTrail(
  raw: import('better-sqlite3').Database,
  workspaceId: string,
  workstreamId: string,
): void {
  raw
    .prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run(workstreamId, workspaceId, `ws ${workstreamId}`, Date.now(), Date.now());
  raw
    .prepare(
      `INSERT INTO workstream_decisions
         (id, workstream_id, decision_kind, rationale, evidence_refs, content_hash, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'dec_hp_1',
      workstreamId,
      'route',
      'Higgsfield gewählt weil heygen 0× lieferte',
      JSON.stringify(['ev_sentinel']),
      'hash_dec_hp_1',
      'agent',
      Date.now(),
    );
}

function insertWorkspaceRow(
  raw: import('better-sqlite3').Database,
  id: string,
  notes: string | null,
  notesSource: string | null,
): void {
  raw
    .prepare(
      `INSERT INTO workspaces (id, notes, notes_updated_at, notes_source) VALUES (?, ?, ?, ?)`,
    )
    .run(id, notes, notes != null ? Date.now() : null, notesSource);
}

async function importExecutePlan() {
  const mod = await import('@/lib/workstreams/plan-executor');
  return mod.executePlan;
}

function singleTextStep() {
  return [
    {
      id: 'STEP-1',
      workstreamId: H.WORKSTREAM_ID,
      planId: H.PLAN_ID,
      parentStepId: null,
      stepIndex: 1,
      title: 'Step 1 (researcher)',
      rationale: 'Rationale 1',
      subagentRole: 'researcher',
      targetFilesJson: null,
      expectedArtifactsJson: null,
      depth: 0,
      coordKey: `${H.WORKSPACE_ID}/${H.WORKSTREAM_ID}`,
      allowedTools: null,
      dependsOn: null,
      groupId: null,
      status: 'pending',
      contentHash: 'a'.repeat(64),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
}

const runArgs = {
  workstreamId: H.WORKSTREAM_ID,
  workspaceId: H.WORKSPACE_ID,
  planId: H.PLAN_ID,
  coordKey: `${H.WORKSPACE_ID}/${H.WORKSTREAM_ID}`,
};

function readNotes(
  raw: import('better-sqlite3').Database,
  id: string,
): { notes: string | null; notes_source: string | null } | undefined {
  return raw
    .prepare('SELECT notes, notes_source FROM workspaces WHERE id = ?')
    .get(id) as { notes: string | null; notes_source: string | null } | undefined;
}

describe('plan-executor Done-Hook — E5.1 Auto-Workspace-Handoff persist', () => {
  let raw: import('better-sqlite3').Database;

  beforeEach(() => {
    vi.clearAllMocks();
    raw = freshDb();
    H.db = { $raw: raw };
    // text-only engine path (kein Modus gesetzt → plan-only → engine.chat).
    H.engineChat.mockResolvedValue({ text: 'chat output' });
    H.emitCompleted.mockResolvedValue(undefined);
    H.listRootPlanSteps.mockReturnValue(singleTextStep());
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    raw.close();
  });

  // ── (1) Nach Run-Abschluss steht eine ai-summary in workspaces.notes ──────

  it('(1) writes an ai-summary into workspaces.notes after run completion', async () => {
    insertWorkspaceRow(raw, H.WORKSPACE_ID, null, null);
    seedWorkspaceWithTrail(raw, H.WORKSPACE_ID, H.WORKSTREAM_ID);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    const row = readNotes(raw, H.WORKSPACE_ID);
    expect(row).toBeDefined();
    expect(row!.notes_source).toBe('ai-summary');
    expect(row!.notes).toContain('Higgsfield gewählt');
    // Abschluss-Card wurde trotzdem emittiert (Done-Hook lief vollständig durch).
    expect(H.emitCompleted).toHaveBeenCalledTimes(1);
  });

  // ── (2) 'manual'-notes bleiben unangetastet (REPLACE-Schutz) ──────────────

  it("(2) does NOT overwrite manual notes (REPLACE-Schutz greift)", async () => {
    insertWorkspaceRow(raw, H.WORKSPACE_ID, 'Vom User gepflegtes CLAUDE.md', 'manual');
    seedWorkspaceWithTrail(raw, H.WORKSPACE_ID, H.WORKSTREAM_ID);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    const row = readNotes(raw, H.WORKSPACE_ID);
    expect(row!.notes).toBe('Vom User gepflegtes CLAUDE.md');
    expect(row!.notes_source).toBe('manual');
    // Run-Abschluss lief trotzdem durch.
    expect(H.emitCompleted).toHaveBeenCalledTimes(1);
  });

  // ── (3) Fehler im Handoff-Persist kippt den Abschluss NICHT ───────────────

  it('(3) a handoff-persist error does NOT abort the run (fail-soft)', async () => {
    // Kein workspaces-Row angelegt: persistWorkspaceHandoff macht ein
    // UPDATE auf nicht-existente id → SELECT notes_source liefert undefined →
    // currentSource=null → es WIRD geschrieben (0 Zeilen betroffen, kein Wurf).
    // Um einen echten WURF im Persist-Pfad zu erzwingen, droppen wir die
    // workspaces-Tabelle NACHDEM das Build sie nicht braucht — der UPDATE
    // wirft dann ("no such table: workspaces"), der Done-Hook muss das
    // schlucken und trotzdem die Abschluss-Card emittieren.
    seedWorkspaceWithTrail(raw, H.WORKSPACE_ID, H.WORKSTREAM_ID);
    raw.exec('DROP TABLE workspaces;');

    const executePlan = await importExecutePlan();
    // Darf NICHT werfen.
    await expect(executePlan(runArgs)).resolves.toBeUndefined();

    // Abschluss-Card wurde trotz Persist-Fehler emittiert → Run-Abschluss intakt.
    expect(H.emitCompleted).toHaveBeenCalledTimes(1);
  });
});
