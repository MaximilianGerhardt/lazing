/**
 * lib/workstreams/__tests__/plan-executor-exec-parallel.test.ts
 * --------------------------------------------------------------
 * EXEC (2026-05-26) — Integration-Tests für den konsent-gated, R1-isolierten,
 * parallelen Plan-Executor.
 *
 * Deckt ab:
 *   (1) unset (kein Modus) → plan-only: KEIN echter Tool-Spawn, nur engine.chat
 *       (text-only). Beweist: Default = exakt heutiges sicheres Verhalten.
 *   (2) FreeRein + coder → echter Spawn MIT Bash, ZWINGEND in R1-Worktree
 *       (createRunWorktree aufgerufen, spawnInTmux bekommt den Worktree-Pfad +
 *       Bash in allowedTools, discardRunWorktree im finally).
 *   (3) Lane + coder → echter Spawn MIT Write, OHNE Bash. Lane + tester →
 *       read-only (kein Write, kein Bash).
 *   (4) Parallelität: unabhängige Steps laufen gleichzeitig (gebunden durch
 *       N11 heavyTotal), abhängige Steps sequenziell (depends_on respektiert),
 *       Cycle → sequenzieller Fallback.
 *
 * Mock-Strategie: alle IO-Ränder (DB, Workspace-FS, tmux-spawn, worktree-manager,
 * resource-pool, engine) sind gemockt. Das Gate (enforceExecutionStep) läuft
 * ECHT — wir wollen die echte mode→R2→spawn-Kette testen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── W1.1 (2026-05-30): real temp worktree für das Non-empty-Diff-Gate ─────────
// Der plan-executor prüft jetzt nach exit=0, ob der Worktree-Diff nicht-leer ist
// (captureWorktreeDiff, echtes git). Diese Tests simulieren einen erfolgreichen
// Spawn, der ein ARTEFAKT schreibt → wir brauchen einen echten git-Worktree mit
// einer geänderten Datei, sonst failt das Gate (no_artifact) korrekt.
const CREATED_WORKTREES: string[] = [];
function initRealWorktree(): string {
  // Prefix enthält '.lazing-worktrees', damit Isolations-Asserts (workspacePath
  // contains '.lazing-worktrees') unverändert greifen.
  const dir = mkdtempSync(join(tmpdir(), '.lazing-worktrees-'));
  CREATED_WORKTREES.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
  return dir;
}

// ── Hoisted shared state ─────────────────────────────────────────────────────

const H = vi.hoisted(() => ({
  WORKSPACE_ID: 'ws-exec-001',
  WORKSTREAM_ID: 'WS-exec-001',
  PLAN_ID: 'PLN-exec-001',
  // Permission-Mode den die DB-Mock zurückgibt (pro Test gesetzt).
  modeRow: { value: null as string | null },
  // Spawn-/Worktree-Spies (AKKUMULATIONS-Modell: Run-Branch + Step-Worktree).
  spawnInTmux: vi.fn(),
  createOrReuseRunWorktree: vi.fn(),
  createStepWorktree: vi.fn(),
  mergeStepIntoRun: vi.fn(),
  discardStepWorktree: vi.fn(),
  // N8/N10 tamper-evident decision writer spy.
  writeDecision: vi.fn(),
  // Concurrency-Tracking für den Parallelitäts-Test.
  concurrency: { current: 0, max: 0 },
  // Reihenfolge der gestarteten Step-IDs (für depends_on-Ordering).
  startOrder: [] as string[],
  listRootPlanSteps: vi.fn(),
  setPlanStepStatus: vi.fn(),
  engineChat: vi.fn(),
  pickEngineId: { value: 'claude-cli' as 'claude-cli' | 'ollama' },
  // Getrennte Klassen-Budgets (per-Test überschreibbar). Defaults wie prod.
  budget: { heavyOllama: 2, spawnConcurrency: 5, textConcurrency: 6 },
}));

// ── Mock: plan-repo ──────────────────────────────────────────────────────────

vi.mock('@/lib/workstreams/plan-repo', () => ({
  listRootPlanSteps: (...a: unknown[]) => H.listRootPlanSteps(...a),
  setPlanStepStatus: (...a: unknown[]) => H.setPlanStepStatus(...a),
}));

// ── Mock: engine selector (REAL gate, mocked engine) ─────────────────────────

vi.mock('@/lib/llm/engines/selector', () => ({
  detectEngines: vi.fn().mockResolvedValue({ available: [{ engine: 'claude-cli', available: true }] }),
  pickEngine: () => ({ id: H.pickEngineId.value, chat: H.engineChat }),
}));

// ── Mock: resource-pool (getrennte Klassen-Budgets, SLOT-DECOUPLING) ─────────
//
// getConcurrencyBudget liefert die per-Test überschreibbaren Klassen-Limits.
// heavyOllama=2 (echte N11-Grenze), spawnConcurrency=5 (== Worktree-Cap),
// textConcurrency=6 (Cores-abgeleitet). Tests setzen H.budget.* um die Breite
// pro Klasse gezielt zu prüfen, ohne von der lokalen Core-Zahl abzuhängen.

vi.mock('@/lib/agents/resource-pool', () => ({
  resourcePool: {
    acquireSlot: vi.fn().mockImplementation(async () => ({ slotId: `slot-${Math.random()}` })),
    releaseSlot: vi.fn(),
    getBudget: vi.fn().mockReturnValue({ heavyTotal: 2, perKind: { 'ollama-heavy': 1 } }),
    getConcurrencyBudget: vi.fn().mockImplementation(() => ({ ...H.budget })),
  },
}));

vi.mock('@/lib/agents/tpm-budget', () => ({
  waitForBudget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/events/emit-or-update-card', () => ({
  emitOrUpdateCard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/events/emit', () => ({
  emitChatMessageCompleted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/ulid', () => ({ ulid: () => 'ULID-mock' }));

// ── Mock: workstream service (lazy import) ───────────────────────────────────

vi.mock('@/lib/workstreams/service', () => ({
  getWorkstream: vi.fn().mockResolvedValue({ name: 'Exec-WS', description: 'exec test' }),
}));

// ── Mock: db/client — readWorkspacePermissionMode liest $raw.prepare().get() ──

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: (_sql: string) => ({
        get: (_wsId: string) =>
          H.modeRow.value ? { mode: H.modeRow.value } : undefined,
      }),
    },
  }),
}));

// ── Mock: workspaces — resolveWorkspacePath uses getWorkspace().path ─────────

vi.mock('@/lib/workspaces', () => ({
  getWorkspace: vi.fn().mockResolvedValue({ path: '/fake/repo/path' }),
}));

// ── Mock: worktree-manager (R1 isolation) ────────────────────────────────────

vi.mock('@/lib/agents/worktree-manager', () => ({
  createOrReuseRunWorktree: (...a: unknown[]) => H.createOrReuseRunWorktree(...a),
  createStepWorktree: (...a: unknown[]) => H.createStepWorktree(...a),
  mergeStepIntoRun: (...a: unknown[]) => H.mergeStepIntoRun(...a),
  discardStepWorktree: (...a: unknown[]) => H.discardStepWorktree(...a),
}));

// ── Mock: tmux-spawn (real tool spawn) ───────────────────────────────────────

vi.mock('@/server/agents/tmux-spawn', () => ({
  spawnInTmux: (...a: unknown[]) => H.spawnInTmux(...a),
}));

// ── Mock: trace-repo — N8/N10 tamper-evident decision writer ──────────────────

vi.mock('@/lib/workstreams/trace-repo', () => ({
  writeDecision: (...a: unknown[]) => H.writeDecision(...a),
}));

// ── Step-row fixture ─────────────────────────────────────────────────────────

function step(
  id: string,
  index: number,
  role: string,
  opts: { dependsOn?: string[]; groupId?: string | null } = {},
) {
  return {
    id,
    workstreamId: H.WORKSTREAM_ID,
    planId: H.PLAN_ID,
    parentStepId: null,
    stepIndex: index,
    title: `Step ${index} (${role})`,
    rationale: `Rationale ${index}`,
    subagentRole: role,
    targetFilesJson: null,
    expectedArtifactsJson: null,
    depth: 0,
    coordKey: `${H.WORKSPACE_ID}/${H.WORKSTREAM_ID}`,
    allowedTools: null,
    dependsOn: opts.dependsOn ? JSON.stringify(opts.dependsOn) : null,
    groupId: opts.groupId ?? null,
    status: 'pending',
    contentHash: 'a'.repeat(64),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function importExecutePlan() {
  const mod = await import('@/lib/workstreams/plan-executor');
  return mod.executePlan;
}

const runArgs = {
  workstreamId: H.WORKSTREAM_ID,
  workspaceId: H.WORKSPACE_ID,
  planId: H.PLAN_ID,
  coordKey: `${H.WORKSPACE_ID}/${H.WORKSTREAM_ID}`,
};

describe('plan-executor EXEC — consent-gated, R1-isolated, parallel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.modeRow.value = null;
    H.pickEngineId.value = 'claude-cli';
    H.concurrency.current = 0;
    H.concurrency.max = 0;
    H.startOrder = [];
    // Klassen-Budgets pro Test auf prod-Default zurücksetzen.
    H.budget = { heavyOllama: 2, spawnConcurrency: 5, textConcurrency: 6 };

    // engine.chat: text-only path; track concurrency.
    H.engineChat.mockImplementation(async () => {
      H.concurrency.current += 1;
      H.concurrency.max = Math.max(H.concurrency.max, H.concurrency.current);
      await new Promise((r) => setTimeout(r, 15));
      H.concurrency.current -= 1;
      return { text: 'chat output' };
    });

    // worktree mocks (AKKUMULATION): run-branch + step-worktree + merge succeed.
    H.createOrReuseRunWorktree.mockImplementation(async (a: { runId: string }) => ({
      runBranch: `lazing/run/${a.runId}`,
    }));
    H.createStepWorktree.mockImplementation(async (a: { stepId: string; baseBranch: string }) => ({
      // W1.1: ein ECHTER git-Worktree (frisch je Step), damit das Non-empty-
      // Diff-Gate gegen echtes git läuft. Der Spawn-Mock schreibt darin ein
      // Artefakt (siehe spawnInTmux). baseSha = HEAD des frischen Repos.
      worktreePath: initRealWorktree(),
      stepBranch: `lazing/step/${a.stepId}`,
    }));
    H.mergeStepIntoRun.mockResolvedValue({ merged: true });
    H.discardStepWorktree.mockResolvedValue(undefined);

    // writeDecision: returns a fake row-id (writer is content_hash-chained).
    H.writeDecision.mockReturnValue('dec_mock_001');

    // spawn mock: succeed; track concurrency + order.
    H.spawnInTmux.mockImplementation(async (a: { workspacePath: string }) => {
      H.concurrency.current += 1;
      H.concurrency.max = Math.max(H.concurrency.max, H.concurrency.current);
      await new Promise((r) => setTimeout(r, 15));
      H.concurrency.current -= 1;
      // W1.1: ein erfolgreicher Spawn schreibt ein ECHTES Artefakt in den
      // Worktree → das Non-empty-Diff-Gate sieht einen nicht-leeren Diff.
      try {
        writeFileSync(join(a.workspacePath, 'index.html'), '<html>artifact</html>\n');
      } catch { /* ignore */ }
      return {
        text: `spawned in ${a.workspacePath}`,
        tokens: { input: 1, output: 2, cacheRead: 0 },
        costCents: 0,
        durationMs: 1,
        exitCode: 0,
        rateLimited: false,
        timedOut: false,
      };
    });

    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // W1.1: die echten Temp-Worktrees aufräumen (kein Leak über Tests).
    while (CREATED_WORKTREES.length > 0) {
      const d = CREATED_WORKTREES.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── (1) unset → plan-only: NO real spawn, text-only ───────────────────────

  it('(1) unset mode → plan-only: no real tool-spawn, engine.chat only (default-safe)', async () => {
    H.modeRow.value = null; // kein Modus gesetzt
    H.listRootPlanSteps.mockReturnValue([step('STEP-1', 1, 'coder')]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // KEIN echter Spawn, KEIN Worktree — exakt heutiges sicheres Verhalten.
    expect(H.spawnInTmux).not.toHaveBeenCalled();
    expect(H.createStepWorktree).not.toHaveBeenCalled();
    // Run-Branch wird nur bei canRealSpawn angelegt → bei unset/text-only nie.
    expect(H.createOrReuseRunWorktree).not.toHaveBeenCalled();
    // engine.chat (text-only) lief.
    expect(H.engineChat).toHaveBeenCalledTimes(1);
    // Step done.
    const done = (H.setPlanStepStatus.mock.calls as [string, string][]).find(
      ([id, s]) => id === 'STEP-1' && s === 'done',
    );
    expect(done).toBeDefined();
  });

  // ── (2) FreeRein + coder → real spawn WITH Bash, in R1-worktree ────────────

  it('(2) freerein + coder → real spawn with Bash, isolated in R1 worktree, discarded after', async () => {
    H.modeRow.value = 'freerein';
    H.listRootPlanSteps.mockReturnValue([step('STEP-1', 1, 'coder')]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // AKKUMULATION: Run-Branch EINMAL (vor Scheduler), Step-Worktree pro Step
    // (vom Run-Tip), Merge bei exit=0, discardStepWorktree danach. Run-Branch
    // wird NIE verworfen (kein discardRunWorktree-Aufruf).
    expect(H.createOrReuseRunWorktree).toHaveBeenCalledTimes(1);
    expect(H.createStepWorktree).toHaveBeenCalledTimes(1);
    expect(H.mergeStepIntoRun).toHaveBeenCalledTimes(1);
    expect(H.discardStepWorktree).toHaveBeenCalledTimes(1);
    const stepArgs = H.createStepWorktree.mock.calls[0][0] as {
      repoPath: string;
      baseBranch: string;
    };
    expect(stepArgs.repoPath).toBe('/fake/repo/path');
    // Step branched VOM RUN-TIP, nicht von Live-HEAD (Komposition).
    expect(stepArgs.baseBranch).toMatch(/^lazing\/run\//);
    const mergeArgs = H.mergeStepIntoRun.mock.calls[0][0] as {
      runBranch: string;
      stepBranch: string;
    };
    expect(mergeArgs.runBranch).toMatch(/^lazing\/run\//);
    expect(mergeArgs.stepBranch).toMatch(/^lazing\/step\//);

    // Echter Spawn lief; NICHT der text-only-Pfad.
    expect(H.spawnInTmux).toHaveBeenCalledTimes(1);
    expect(H.engineChat).not.toHaveBeenCalled();

    const spawnArgs = H.spawnInTmux.mock.calls[0][0] as {
      workspacePath: string;
      allowedTools: string[];
    };
    // Isolation: der Spawn bekommt den ISOLIERTEN Worktree-Pfad, NIE den Live-Repo.
    expect(spawnArgs.workspacePath).toContain('.lazing-worktrees');
    expect(spawnArgs.workspacePath).not.toBe('/fake/repo/path');
    // FreeRein + coder → Bash + Write in allowedTools.
    expect(spawnArgs.allowedTools).toContain('Bash');
    expect(spawnArgs.allowedTools).toContain('Write');

    const done = (H.setPlanStepStatus.mock.calls as [string, string][]).find(
      ([id, s]) => id === 'STEP-1' && s === 'done',
    );
    expect(done).toBeDefined();
  });

  // ── (2b) N8/N10: a FreeRein real-spawn writes a tamper-evident decision row ─

  it('(2b) freerein real spawn → writes a content_hash-chained workstream_decisions row (N8/N10)', async () => {
    H.modeRow.value = 'freerein';
    H.listRootPlanSteps.mockReturnValue([step('STEP-1', 1, 'coder')]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // A real spawn happened → exactly one decision row must have been written
    // BEFORE the spawn (writeDecision is the content_hash-chained N10 writer).
    expect(H.writeDecision).toHaveBeenCalledTimes(1);
    expect(H.spawnInTmux).toHaveBeenCalledTimes(1);

    const decArg = H.writeDecision.mock.calls[0][0] as {
      workspaceId: string;
      workstreamId: string;
      coordKey: string;
      decisionKind: string;
      actor: string;
      rationale: string;
    };
    // Routing/spawn-authorization decision, written by the deterministic policy.
    expect(decArg.decisionKind).toBe('route');
    expect(decArg.actor).toBe('policy');
    expect(decArg.workstreamId).toBe(H.WORKSTREAM_ID);
    expect(decArg.coordKey).toBe(`${H.WORKSPACE_ID}/${H.WORKSTREAM_ID}`);
    // Verbatim rationale (N1, no .slice): carries mode, step.id, granted tools
    // (incl. Bash), and real_spawn:true.
    expect(decArg.rationale).toContain('real_spawn=true');
    expect(decArg.rationale).toContain('mode=freerein');
    expect(decArg.rationale).toContain('step=STEP-1');
    expect(decArg.rationale).toContain('"Bash"'); // granted_tools JSON includes Bash
    expect(decArg.rationale).toContain('granted_tools=');
  });

  it('(2c) unset/text-only path writes NO decision row (no real tool run)', async () => {
    H.modeRow.value = null;
    H.listRootPlanSteps.mockReturnValue([step('STEP-1', 1, 'coder')]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // text-only is tool-less → no real tool run → no decision row.
    expect(H.writeDecision).not.toHaveBeenCalled();
    expect(H.spawnInTmux).not.toHaveBeenCalled();
    expect(H.engineChat).toHaveBeenCalledTimes(1);
  });

  // ── (3) Lane → Write yes / Bash no; tester read-only ──────────────────────

  it('(3) lane + coder → real spawn with Write, NO Bash', async () => {
    H.modeRow.value = 'lane';
    H.listRootPlanSteps.mockReturnValue([step('STEP-1', 1, 'coder')]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    expect(H.spawnInTmux).toHaveBeenCalledTimes(1);
    const spawnArgs = H.spawnInTmux.mock.calls[0][0] as { allowedTools: string[] };
    expect(spawnArgs.allowedTools).toContain('Write');
    expect(spawnArgs.allowedTools).not.toContain('Bash');
    // R1 isolation still enforced for write-mode (Step-Worktree vom Run-Tip).
    expect(H.createStepWorktree).toHaveBeenCalledTimes(1);
  });

  it('(3b) lane + tester → read-only: real spawn allowed but NO Write, NO Bash', async () => {
    H.modeRow.value = 'lane';
    H.listRootPlanSteps.mockReturnValue([step('STEP-1', 1, 'tester')]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // tester has read-only tools under lane (Read/Grep/Glob) → still a real
    // spawn (tools granted), but neither Write nor Bash.
    expect(H.spawnInTmux).toHaveBeenCalledTimes(1);
    const spawnArgs = H.spawnInTmux.mock.calls[0][0] as { allowedTools: string[] };
    expect(spawnArgs.allowedTools).not.toContain('Write');
    expect(spawnArgs.allowedTools).not.toContain('Bash');
    expect(spawnArgs.allowedTools).toContain('Read');
  });

  // ── (4) Parallelism ───────────────────────────────────────────────────────

  it('(4a) 6 independent text-only steps → MORE than 2 run concurrently (no artificial 2-cap), bounded by textConcurrency', async () => {
    H.modeRow.value = null; // text-only path (engine.chat tracks concurrency)
    H.budget.textConcurrency = 6; // explicit, core-count-independent
    // 6 independent steps (no depends_on).
    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder'),
      step('STEP-2', 2, 'coder'),
      step('STEP-3', 3, 'coder'),
      step('STEP-4', 4, 'coder'),
      step('STEP-5', 5, 'coder'),
      step('STEP-6', 6, 'coder'),
    ]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    expect(H.engineChat).toHaveBeenCalledTimes(6);
    // REGRESSION GUARD: the old code capped at heavyTotal=2. Now text-only
    // steps run up to textConcurrency. Prove MORE than 2 ran at once …
    expect(H.concurrency.max).toBeGreaterThan(2);
    // … and never more than the text class budget (no over-subscription).
    expect(H.concurrency.max).toBeLessThanOrEqual(6);
  });

  it('(4a-i) text steps NEVER acquire a heavy-Ollama slot (the decoupling bugfix)', async () => {
    H.modeRow.value = null; // text-only / claude-cli engine
    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder'),
      step('STEP-2', 2, 'coder'),
      step('STEP-3', 3, 'coder'),
    ]);

    const { resourcePool } = await import('@/lib/agents/resource-pool');
    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // The whole point: a text-only/claude-cli step must NOT consume one of the
    // 2 heavy-Ollama slots. acquireSlot is only for genuine heavy-Ollama use.
    expect(resourcePool.acquireSlot).not.toHaveBeenCalled();
    expect(H.engineChat).toHaveBeenCalledTimes(3);
  });

  it('(4a-ii) 6 independent WRITE steps (lane) → up to worktree-cap (5) run concurrently, NOT 2', async () => {
    H.modeRow.value = 'lane'; // real-spawn path → spawnConcurrency = worktree-cap 5
    H.budget.spawnConcurrency = 5; // == MAX_RUN_WORKTREES
    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder'),
      step('STEP-2', 2, 'coder'),
      step('STEP-3', 3, 'coder'),
      step('STEP-4', 4, 'coder'),
      step('STEP-5', 5, 'coder'),
      step('STEP-6', 6, 'coder'),
    ]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // All 6 spawned (real tool-spawns), R1-isolated.
    expect(H.spawnInTmux).toHaveBeenCalledTimes(6);
    // Decoupled: more than the old 2-cap ran concurrently …
    expect(H.concurrency.max).toBeGreaterThan(2);
    // … bounded by the worktree-cap (5), never over-subscribed.
    expect(H.concurrency.max).toBeLessThanOrEqual(5);
  }, 30_000); // W1.1: echtes git-I/O pro Step (Non-empty-Diff-Gate) → großzügiger Timeout.

  it('(4a-iii) heavy-Ollama plan-steps stay bounded at 2 (real N11 cap preserved)', async () => {
    H.modeRow.value = null;
    H.pickEngineId.value = 'ollama'; // engine is ollama → usesHeavyOllama=true
    H.budget.textConcurrency = 6; // generous text budget — must NOT matter here

    // The heavy-Ollama bound lives in acquireSlot (heavyTotal=2), NOT in the
    // scheduler width. Mock acquireSlot to enforce the real 2-slot semantics so
    // we prove the executor still routes ollama steps through the heavy pool.
    const { resourcePool } = await import('@/lib/agents/resource-pool');
    let heavyInflight = 0;
    let heavyMax = 0;
    const heldResolvers: Array<() => void> = [];
    (resourcePool.acquireSlot as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Block until a slot frees when 2 are already inflight (real pool semantics).
      while (heavyInflight >= 2) {
        await new Promise<void>((r) => heldResolvers.push(r));
      }
      heavyInflight += 1;
      heavyMax = Math.max(heavyMax, heavyInflight);
      return { slotId: `heavy-${Math.random()}` };
    });
    (resourcePool.releaseSlot as ReturnType<typeof vi.fn>).mockImplementation(() => {
      heavyInflight -= 1;
      const next = heldResolvers.shift();
      if (next) next();
    });

    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder'),
      step('STEP-2', 2, 'coder'),
      step('STEP-3', 3, 'coder'),
      step('STEP-4', 4, 'coder'),
    ]);

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // All 4 ran via ollama (text path, but heavy-slot-gated).
    expect(H.engineChat).toHaveBeenCalledTimes(4);
    // The heavy-Ollama N11 cap of 2 was never exceeded.
    expect(heavyMax).toBeLessThanOrEqual(2);
    expect(heavyMax).toBeGreaterThanOrEqual(1);
    expect(resourcePool.acquireSlot).toHaveBeenCalled();
  });

  it('(4b) dependent steps run sequentially (depends_on respected)', async () => {
    H.modeRow.value = null;
    // STEP-2 depends on STEP-1, STEP-3 depends on STEP-2 → strict chain.
    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder'),
      step('STEP-2', 2, 'coder', { dependsOn: ['STEP-1'] }),
      step('STEP-3', 3, 'coder', { dependsOn: ['STEP-2'] }),
    ]);

    // Track active-set ordering: each chat records the id it runs for.
    const activeAt: string[] = [];
    H.engineChat.mockImplementation(async () => {
      // capture which 'active' status was last set
      const calls = H.setPlanStepStatus.mock.calls as [string, string][];
      const lastActive = [...calls].reverse().find(([, s]) => s === 'active');
      if (lastActive) activeAt.push(lastActive[0]);
      H.concurrency.current += 1;
      H.concurrency.max = Math.max(H.concurrency.max, H.concurrency.current);
      await new Promise((r) => setTimeout(r, 10));
      H.concurrency.current -= 1;
      return { text: 'ok' };
    });

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    // A strict dependency chain can never run more than 1 at a time.
    expect(H.concurrency.max).toBe(1);
    // All three executed.
    expect(H.engineChat).toHaveBeenCalledTimes(3);
    // STEP-1 done before STEP-2 active, STEP-2 done before STEP-3 active.
    const order = (H.setPlanStepStatus.mock.calls as [string, string][]);
    const idx = (id: string, st: string) => order.findIndex(([i, s]) => i === id && s === st);
    expect(idx('STEP-1', 'done')).toBeLessThan(idx('STEP-2', 'active'));
    expect(idx('STEP-2', 'done')).toBeLessThan(idx('STEP-3', 'active'));
  });

  it('(4c) cycle in depends_on → sequential fallback, no deadlock', async () => {
    H.modeRow.value = null;
    // STEP-1 ↔ STEP-2 cycle. Must NOT deadlock — falls back to sequential.
    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder', { dependsOn: ['STEP-2'] }),
      step('STEP-2', 2, 'coder', { dependsOn: ['STEP-1'] }),
    ]);

    const executePlan = await importExecutePlan();
    // The key assertion: it RESOLVES (no hang). vitest would time out on deadlock.
    await expect(executePlan(runArgs)).resolves.toBeUndefined();

    // Both steps ran (cycle fallback ignores deps).
    expect(H.engineChat).toHaveBeenCalledTimes(2);
    // Sequential fallback → never concurrent.
    expect(H.concurrency.max).toBe(1);
  });

  it('(4d) a failed dependency blocks dependents (fail-isolated)', async () => {
    H.modeRow.value = null;
    H.listRootPlanSteps.mockReturnValue([
      step('STEP-1', 1, 'coder'),
      step('STEP-2', 2, 'coder', { dependsOn: ['STEP-1'] }),
    ]);
    // STEP-1's chat throws → STEP-1 failed → STEP-2 never becomes ready.
    H.engineChat.mockImplementationOnce(async () => {
      throw new Error('boom in step 1');
    });
    H.engineChat.mockImplementation(async () => ({ text: 'ok' }));

    const executePlan = await importExecutePlan();
    await executePlan(runArgs);

    const calls = H.setPlanStepStatus.mock.calls as [string, string][];
    expect(calls.find(([i, s]) => i === 'STEP-1' && s === 'failed')).toBeDefined();
    // STEP-2 must be failed (blocked), and engine.chat for it must NOT have run.
    expect(calls.find(([i, s]) => i === 'STEP-2' && s === 'failed')).toBeDefined();
    expect(calls.find(([i, s]) => i === 'STEP-2' && s === 'done')).toBeUndefined();
  });
});
