/**
 * lib/workstreams/__tests__/plan-executor-security-gate.test.ts
 * --------------------------------------------------------------
 * Security-Gate-Integration-Tests für plan-executor.ts (R2 / EXEC 2026-05-26).
 *
 * NEUES MODELL (EXEC, 2026-05-26): das R2-Gate (enforceExecutionStep) ist die
 * AUTORISIERUNG für einen ECHTEN Tool-Spawn — es wird NUR aufgerufen, wenn der
 * Workspace-Modus überhaupt Tools gewährt (FreeRein/Lane) UND ein echter Spawn
 * möglich ist. Im Default (unset/ask) läuft der sichere text-only-Pfad ganz
 * OHNE Gate (tool-los, kein Write, keine Shell — per se unkritisch).
 *
 * Deshalb setzen diese Tests einen tool-gewährenden Modus (freerein) über die
 * gemockte DB, damit der Gate-Pfad exerziert wird. Das Gate selbst ist gemockt
 * (mockGate), damit wir Allow/Deny pro Step deterministisch steuern können.
 *
 * Testziele:
 *   (a) Allow → echter Spawn läuft (in R1-Worktree), Step 'done'.
 *   (b) Gate denied für Step B → Step B fällt auf text-only zurück (defense-in-
 *       depth, KEIN Crash), A+C spawnen. Alle Steps 'done', kein 'failed'.
 *   (c) Gate-Deny → text-only-Fallback statt Tool-Spawn (kein Crash).
 *   (d) Backward-compat: allowed_tools=null verhält sich wie absent.
 *
 * N6: Deterministisches Gate vor jeder ECHTEN Ausführung — verifiziert.
 * N8: Audit-Log via console.info/console.warn — verifiziert.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ExecutionStepRequest, ExecutionDecision } from '@/lib/security/execution-policy';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// W1.1 (2026-05-30): echte Temp-Worktrees fürs Non-empty-Diff-Gate (s.u.).
const SEC_WORKTREES: string[] = [];
function initSecWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), '.lazing-worktrees-'));
  SEC_WORKTREES.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@local']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'test']);
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
  return dir;
}

// ---------------------------------------------------------------------------
// Hoist shared IDs + gate mock control state
// ---------------------------------------------------------------------------

const {
  WORKSPACE_ID, WORKSTREAM_ID, PLAN_ID,
  STEP_A_ID, STEP_B_ID, STEP_C_ID,
  mockGate, modeRow,
} = vi.hoisted(() => {
  const mockGate = vi.fn() as ReturnType<typeof vi.fn<(req: ExecutionStepRequest) => ExecutionDecision>>;
  return {
    WORKSPACE_ID: 'ws-gate-test-001',
    WORKSTREAM_ID: 'WS-gate-001',
    PLAN_ID: 'PLN-gate-001',
    STEP_A_ID: 'STEP-A-001',
    STEP_B_ID: 'STEP-B-001',
    STEP_C_ID: 'STEP-C-001',
    mockGate,
    // The workspace mode the mocked DB returns. 'freerein' grants tools so the
    // gate path is exercised (the gate is the spawn authorization).
    modeRow: { value: 'freerein' as string | null },
  };
});

// ---------------------------------------------------------------------------
// Mock: lib/security/execution-policy  ← MUST be hoisted before plan-executor
// ---------------------------------------------------------------------------

vi.mock('@/lib/security/execution-policy', () => ({
  enforceExecutionStep: (req: ExecutionStepRequest) => mockGate(req),
}));

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const mockSetPlanStepStatus = vi.fn();
const mockListRootPlanSteps = vi.fn();
const mockChat = vi.fn();
const mockSpawnInTmux = vi.fn();
// AKKUMULATIONS-Modell (2026-05-29): Run-Branch + Step-Worktree + serieller Merge.
const mockCreateOrReuseRunWorktree = vi.fn();
const mockCreateStepWorktree = vi.fn();
const mockMergeStepIntoRun = vi.fn();
const mockDiscardStepWorktree = vi.fn();

// ---------------------------------------------------------------------------
// Mock: lib/workstreams/plan-repo
// ---------------------------------------------------------------------------

vi.mock('@/lib/workstreams/plan-repo', () => ({
  listRootPlanSteps: (...args: unknown[]) => mockListRootPlanSteps(...args),
  setPlanStepStatus: (...args: unknown[]) => mockSetPlanStepStatus(...args),
}));

// ---------------------------------------------------------------------------
// Mock: lib/llm/engines/selector
// ---------------------------------------------------------------------------

vi.mock('@/lib/llm/engines/selector', () => ({
  detectEngines: vi.fn().mockResolvedValue({ available: [{ engine: 'claude-cli', available: true }] }),
  pickEngine: () => ({ id: 'claude-cli', chat: mockChat }),
}));

// ---------------------------------------------------------------------------
// Mock: lib/agents/resource-pool — SLOT-DECOUPLING: die Sequenzialität dieser
// Gate-Tests kommt jetzt aus den Klassen-Limits (text=spawn=1), nicht mehr aus
// heavyTotal. getConcurrencyBudget liefert die per-Klasse-Breite, die der
// plan-executor liest.
// ---------------------------------------------------------------------------

vi.mock('@/lib/agents/resource-pool', () => ({
  resourcePool: {
    acquireSlot: vi.fn().mockResolvedValue({ slotId: 'slot-mock-001' }),
    releaseSlot: vi.fn(),
    getBudget: vi.fn().mockReturnValue({ heavyTotal: 1, perKind: { 'ollama-heavy': 1 } }),
    getConcurrencyBudget: vi
      .fn()
      .mockReturnValue({ heavyOllama: 2, spawnConcurrency: 1, textConcurrency: 1 }),
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

vi.mock('@/lib/ulid', () => ({
  ulid: vi.fn().mockReturnValue('ULID-mock-001'),
}));

vi.mock('@/lib/workstreams/service', () => ({
  getWorkstream: vi.fn().mockResolvedValue({
    name: 'Gate-Test-WS',
    description: 'E2E security gate test workstream',
  }),
}));

// DB mock — readWorkspacePermissionMode reads $raw.prepare().get().mode.
vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: {
      prepare: (_sql: string) => ({
        get: (_wsId: string) => (modeRow.value ? { mode: modeRow.value } : undefined),
      }),
    },
  }),
}));

// Workspace path (for R1 isolation).
vi.mock('@/lib/workspaces', () => ({
  getWorkspace: vi.fn().mockResolvedValue({ path: '/fake/repo' }),
}));

// Worktree-manager (R1 isolation) + tmux-spawn (real tool spawn).
vi.mock('@/lib/agents/worktree-manager', () => ({
  createOrReuseRunWorktree: (...a: unknown[]) => mockCreateOrReuseRunWorktree(...a),
  createStepWorktree: (...a: unknown[]) => mockCreateStepWorktree(...a),
  mergeStepIntoRun: (...a: unknown[]) => mockMergeStepIntoRun(...a),
  discardStepWorktree: (...a: unknown[]) => mockDiscardStepWorktree(...a),
}));

vi.mock('@/server/agents/tmux-spawn', () => ({
  spawnInTmux: (...a: unknown[]) => mockSpawnInTmux(...a),
}));

// ---------------------------------------------------------------------------
// Step-Row-Fixtures
// ---------------------------------------------------------------------------

function makeStepRow(
  id: string,
  index: number,
  role: string,
  allowedTools: string | null = null,
) {
  return {
    id,
    workstreamId: WORKSTREAM_ID,
    planId: PLAN_ID,
    stepIndex: index,
    depth: 0,
    title: `Step ${index}: ${role} task`,
    rationale: `Rationale for step ${index} — ${role} work.`,
    subagentRole: role,
    status: 'pending',
    contentHash: 'a'.repeat(64),
    parentStepId: null,
    allowedTools,
    dependsOn: null,
    groupId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Standard allow decision (gate authorizes a real spawn). */
function allowDecision(role: string): ExecutionDecision {
  return {
    allow: true,
    reason: `Step erlaubt: Rolle '${role}' darf arbeiten.`,
    allowedTools: ['Read', 'Grep', 'Write', 'Edit', 'Bash'],
    requiresBridge: false,
    categories: [],
  };
}

/** Standard deny decision → executor falls back to text-only. */
const BLOCK_DECISION: ExecutionDecision = {
  allow: false,
  reason: 'Simulierter Block: Tool-Anforderung abgelehnt (Test).',
  allowedTools: ['Read', 'Grep'],
  requiresBridge: false,
  categories: ['shell'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan-executor R2 security gate (EXEC)', () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    modeRow.value = 'freerein';

    mockChat.mockResolvedValue({ text: '[LLM text output]' });
    mockCreateOrReuseRunWorktree.mockImplementation(async (a: { runId: string }) => ({
      runBranch: `lazing/run/${a.runId}`,
    }));
    mockCreateStepWorktree.mockImplementation(async (_a: { stepId: string }) => ({
      // W1.1: ECHTER git-Worktree fürs Non-empty-Diff-Gate.
      worktreePath: initSecWorktree(),
      stepBranch: `lazing/step/${_a.stepId}`,
    }));
    mockMergeStepIntoRun.mockResolvedValue({ merged: true });
    mockDiscardStepWorktree.mockResolvedValue(undefined);
    mockSpawnInTmux.mockImplementation(async (a: { workspacePath: string }) => {
      // W1.1: erfolgreicher Spawn schreibt ein echtes Artefakt → Diff nicht-leer.
      try {
        writeFileSync(join(a.workspacePath, 'index.html'), '<html>artifact</html>\n');
      } catch { /* ignore */ }
      return {
        text: '[spawned tool output]',
        tokens: { input: 1, output: 2, cacheRead: 0 },
        costCents: 0,
        durationMs: 1,
        exitCode: 0,
        rateLimited: false,
        timedOut: false,
      };
    });

    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (SEC_WORKTREES.length > 0) {
      const d = SEC_WORKTREES.pop()!;
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // ── (a) Gate allow → real spawn (R1-isolated) → done ──────────────────────

  it('(a) freerein + gate allow → real tool-spawn in R1 worktree → done', async () => {
    mockListRootPlanSteps.mockReturnValue([makeStepRow(STEP_A_ID, 1, 'coder', null)]);
    mockGate.mockImplementation((req) => allowDecision(req.role));

    const { executePlan } = await import('@/lib/workstreams/plan-executor');
    await executePlan({
      workstreamId: WORKSTREAM_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      coordKey: `${WORKSPACE_ID}/${WORKSTREAM_ID}`,
    });

    // Gate called once (spawn authorization).
    expect(mockGate).toHaveBeenCalledTimes(1);
    const [gateReq] = mockGate.mock.calls[0] as [ExecutionStepRequest];
    expect(gateReq.workspaceId).toBe(WORKSPACE_ID);
    expect(gateReq.permissionMode).toBe('freerein');

    // Real spawn ran in an isolated step-worktree (vom Run-Tip); text-only chat
    // did NOT run. Run-Branch wird NIE verworfen (kein discardRunWorktree).
    expect(mockCreateStepWorktree).toHaveBeenCalledTimes(1);
    expect(mockSpawnInTmux).toHaveBeenCalledTimes(1);
    expect(mockChat).not.toHaveBeenCalled();
    expect(mockDiscardStepWorktree).toHaveBeenCalledTimes(1);

    const statusCalls = mockSetPlanStepStatus.mock.calls as [string, string][];
    expect(statusCalls.find(([id, s]) => id === STEP_A_ID && s === 'done')).toBeDefined();

    // N8: allow audit via console.info.
    const infoLines = (consoleInfoSpy.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(infoLines.find((l) => l.includes('[security-gate]') && l.includes(`step=${STEP_A_ID}`) && l.includes('real_spawn=true'))).toBeDefined();
  });

  // ── (b) Gate denies Step B → text-only fallback, no crash, others spawn ───

  it('(b) gate denies one step → that step falls back to text-only, others spawn, no crash', async () => {
    mockListRootPlanSteps.mockReturnValue([
      makeStepRow(STEP_A_ID, 1, 'coder'),
      makeStepRow(STEP_B_ID, 2, 'coder'),
      makeStepRow(STEP_C_ID, 3, 'coder'),
    ]);

    let callCount = 0;
    mockGate.mockImplementation((req) => {
      callCount += 1;
      if (callCount === 2) return BLOCK_DECISION; // STEP_B denied
      return allowDecision(req.role);
    });

    const { executePlan } = await import('@/lib/workstreams/plan-executor');
    await expect(
      executePlan({
        workstreamId: WORKSTREAM_ID,
        workspaceId: WORKSPACE_ID,
        planId: PLAN_ID,
        coordKey: `${WORKSPACE_ID}/${WORKSTREAM_ID}`,
      }),
    ).resolves.toBeUndefined();

    expect(mockGate).toHaveBeenCalledTimes(3);

    // A + C → real spawn (2 spawns). B → text-only fallback (1 chat). No crash.
    expect(mockSpawnInTmux).toHaveBeenCalledTimes(2);
    expect(mockChat).toHaveBeenCalledTimes(1);

    // All three steps end 'done' (deny is a fallback, NOT a failure).
    const statusCalls = mockSetPlanStepStatus.mock.calls as [string, string][];
    for (const id of [STEP_A_ID, STEP_B_ID, STEP_C_ID]) {
      expect(statusCalls.find(([sid, s]) => sid === id && s === 'done')).toBeDefined();
      expect(statusCalls.find(([sid, s]) => sid === id && s === 'failed')).toBeUndefined();
    }

    // N8: deny audit via console.warn for STEP_B.
    const warnLines = (consoleWarnSpy.mock.calls as unknown[][]).map((c) => String(c[0]));
    expect(warnLines.find((l) => l.includes('[security-gate]') && l.includes(`step=${STEP_B_ID}`) && l.includes('real_spawn=false'))).toBeDefined();
  });

  // ── (c) Gate deny → text-only fallback (no tool spawn) ────────────────────

  it('(c) gate deny → text-only fallback, no real tool-spawn, no crash', async () => {
    mockListRootPlanSteps.mockReturnValue([makeStepRow(STEP_A_ID, 1, 'coder')]);
    mockGate.mockImplementation(() => BLOCK_DECISION);

    const { executePlan } = await import('@/lib/workstreams/plan-executor');
    await expect(
      executePlan({
        workstreamId: WORKSTREAM_ID,
        workspaceId: WORKSPACE_ID,
        planId: PLAN_ID,
        coordKey: `${WORKSPACE_ID}/${WORKSTREAM_ID}`,
      }),
    ).resolves.toBeUndefined();

    expect(mockGate).toHaveBeenCalledTimes(1);
    // Deny → NO spawn, NO Step-Worktree; text-only chat instead. (Der Run-Branch
    // wird vorab pro Lauf angelegt — das ist unabhängig vom Per-Step-Gate.)
    expect(mockSpawnInTmux).not.toHaveBeenCalled();
    expect(mockCreateStepWorktree).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledTimes(1);

    // Step still completes (text-only fallback is success).
    const statusCalls = mockSetPlanStepStatus.mock.calls as [string, string][];
    expect(statusCalls.find(([id, s]) => id === STEP_A_ID && s === 'done')).toBeDefined();
  });

  // ── (d) Backward-compat: unset mode → text-only, gate never consulted ─────

  it('(d) unset mode → default-safe text-only, gate NOT consulted', async () => {
    modeRow.value = null; // no workspace mode
    mockListRootPlanSteps.mockReturnValue([makeStepRow(STEP_A_ID, 1, 'reviewer', null)]);
    mockGate.mockImplementation((req) => allowDecision(req.role));

    const { executePlan } = await import('@/lib/workstreams/plan-executor');
    await executePlan({
      workstreamId: WORKSTREAM_ID,
      workspaceId: WORKSPACE_ID,
      planId: PLAN_ID,
      coordKey: `${WORKSPACE_ID}/${WORKSTREAM_ID}`,
    });

    // No mode → no tool grant → text-only path → gate is NOT consulted at all
    // (the gate is the spawn authorization, and no spawn is considered).
    expect(mockGate).not.toHaveBeenCalled();
    expect(mockSpawnInTmux).not.toHaveBeenCalled();
    expect(mockChat).toHaveBeenCalledTimes(1);

    const statusCalls = mockSetPlanStepStatus.mock.calls as [string, string][];
    expect(statusCalls.find(([id, s]) => id === STEP_A_ID && s === 'done')).toBeDefined();
  });
});
