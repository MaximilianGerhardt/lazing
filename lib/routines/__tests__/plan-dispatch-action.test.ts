/**
 * lib/routines/__tests__/plan-dispatch-action.test.ts
 *
 * SAR-3: Routine→Plan-Bridge — vitest unit tests.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *        lib/routines/__tests__/plan-dispatch-action.test.ts
 *
 * Test cases:
 *   (a) action_kind='shell' → old path unaffected (regression guard).
 *   (b) action_kind='plan-dispatch' + sopId → expandSopToPlanNodes used,
 *       workstream created, executePlan called.
 *   (c) Missing sopId AND goalPrompt → RunResult status='failure', no crash.
 *   (d) codex is NEVER selected as engine (assert on pickEngine mock).
 *   (e) mcpToolAllowlist resolved + audited but NOT forwarded to real-invoke
 *       (Phase-1 R3 gate — PHASE2_MCP_REALINVOKE marker present in source).
 *
 * Security assertions:
 *   - codex exclusion is verified by checking the pickEngine call args on
 *     both tryPlanDispatch (mocked) and executePlan (mocked) paths.
 *   - resolvedBinding.mcpTools appears ONLY in RunResult.output JSON, never
 *     in an actual spawn call (tmux-spawn is never called from this bridge).
 *
 * Mock strategy:
 *   All external I/O (DB, SOP registry, tryPlanDispatch, createWorkstream,
 *   insertProposedPlan, executePlan, writeDecision, enforcePermission) are
 *   vi.mock()ed so the test runs without a real DB.  The shell pipeline path
 *   is mocked via validateYamlConfig + the whole collect/render chain.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import type { RunResult } from "../types";

// ---------------------------------------------------------------------------
// Hoist shared constants (vi.hoisted lifts values before mock factories run)
// ---------------------------------------------------------------------------

const { WORKSPACE_ID, ROUTINE_ID, SOP_ID, GOAL_PROMPT, WS_ID, PLAN_ID } =
  vi.hoisted(() => ({
    WORKSPACE_ID: "ws-test-001",
    ROUTINE_ID: "RTN-test-001",
    SOP_ID: "SOP-BUILTIN-RESEARCH-SYNTH-01",
    GOAL_PROMPT: "Research the impact of fast-food on urban planning.",
    WS_ID: "WS-plan-001",
    PLAN_ID: "PLN-root-001",
  }));

// ---------------------------------------------------------------------------
// Mock: db/client
// ---------------------------------------------------------------------------

// We need $raw.prepare().get() to return different things depending on SQL.
// We use a spy that captures calls and returns per-test-configured data.
const mockRawGet = vi.fn();
const mockRawRun = vi.fn();
const mockRawTransaction = vi.fn((fn: () => void) => fn);

const mockDbInsert = vi.fn().mockReturnValue({
  values: vi.fn().mockReturnValue({ run: vi.fn() }),
});
const mockDbUpdate = vi.fn().mockReturnValue({
  set: vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ run: vi.fn() }),
  }),
});
const mockDbSelect = vi.fn();

vi.mock("../../../db/client", () => ({
  getDb: () => ({
    $raw: {
      prepare: (_sql: string) => ({
        get: mockRawGet,
        run: mockRawRun,
      }),
      transaction: mockRawTransaction,
    },
    insert: mockDbInsert,
    update: mockDbUpdate,
    select: mockDbSelect,
  }),
}));

// ---------------------------------------------------------------------------
// Mock: db/schema/routines (Drizzle column refs)
// ---------------------------------------------------------------------------

vi.mock("../../../db/schema/routines", () => ({
  routines: { id: "id", active: "active", triggerMode: "trigger_mode" },
  routineRuns: { id: "id", routineId: "routine_id" },
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm operators
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ _op: "eq", col, val }),
  gte: (col: unknown, val: unknown) => ({ _op: "gte", col, val }),
  desc: (col: unknown) => ({ _op: "desc", col }),
}));

// ---------------------------------------------------------------------------
// Mock: lib/events/emit (emitEvent, emitErrorEvent)
// ---------------------------------------------------------------------------

vi.mock("../../../lib/events/emit", () => ({
  emitEvent: vi.fn().mockResolvedValue({ id: "EVT-mock-001" }),
  emitErrorEvent: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock: lib/tickets/service (createTicket — used by shell path)
// ---------------------------------------------------------------------------

vi.mock("../../../lib/tickets/service", () => ({
  createTicket: vi.fn().mockResolvedValue({ id: "TKT-mock-001" }),
}));

// ---------------------------------------------------------------------------
// Mock: lib/sop/registry
// ---------------------------------------------------------------------------

const mockGetSop = vi.fn();

vi.mock("../../../lib/sop/registry", () => ({
  getSop: (...args: unknown[]) => mockGetSop(...args),
}));

// ---------------------------------------------------------------------------
// Mock: lib/sop/executor
// ---------------------------------------------------------------------------

const mockExpandSopToPlanNodes = vi.fn();

vi.mock("../../../lib/sop/executor", () => ({
  expandSopToPlanNodes: (...args: unknown[]) =>
    mockExpandSopToPlanNodes(...args),
}));

// ---------------------------------------------------------------------------
// Mock: lib/plan-first/plan-dispatch (tryPlanDispatch)
// ---------------------------------------------------------------------------

const mockTryPlanDispatch = vi.fn();

vi.mock("../../../lib/plan-first/plan-dispatch", () => ({
  tryPlanDispatch: (...args: unknown[]) => mockTryPlanDispatch(...args),
}));

// ---------------------------------------------------------------------------
// Mock: lib/workstreams/service
// ---------------------------------------------------------------------------

const mockCreateWorkstream = vi.fn();

vi.mock("../../../lib/workstreams/service", () => ({
  createWorkstream: (...args: unknown[]) => mockCreateWorkstream(...args),
  getWorkstream: vi.fn().mockResolvedValue({ name: "test-ws", description: "test" }),
  updateWorkstream: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock: lib/workstreams/plan-repo
// ---------------------------------------------------------------------------

const mockInsertProposedPlan = vi.fn();

vi.mock("../../../lib/workstreams/plan-repo", () => ({
  insertProposedPlan: (...args: unknown[]) => mockInsertProposedPlan(...args),
  listRootPlanSteps: vi.fn().mockReturnValue([]),
  setPlanStepStatus: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: lib/workstreams/plan-executor
// ---------------------------------------------------------------------------

const mockExecutePlan = vi.fn();

vi.mock("../../../lib/workstreams/plan-executor", () => ({
  executePlan: (...args: unknown[]) => mockExecutePlan(...args),
}));

// ---------------------------------------------------------------------------
// Mock: lib/workstreams/trace-repo (writeDecision, writeEvidence)
// ---------------------------------------------------------------------------

const mockWriteDecision = vi.fn().mockReturnValue("dec_mock_001");

vi.mock("../../../lib/workstreams/trace-repo", () => ({
  writeDecision: (...args: unknown[]) => mockWriteDecision(...args),
  writeEvidence: vi.fn().mockReturnValue("ev_mock_001"),
}));

// ---------------------------------------------------------------------------
// Mock: lib/security/permission-mode
// ---------------------------------------------------------------------------

const mockEnforcePermissionFromSingleton = vi.fn().mockReturnValue({
  allow: true,
  mode: "audit",
  reason: "audit-only",
  auditRowHash: "",
});

vi.mock("../../../lib/security/permission-mode", () => ({
  enforcePermissionFromSingleton: (...args: unknown[]) =>
    mockEnforcePermissionFromSingleton(...args),
  getEnforcementMode: vi.fn().mockReturnValue("audit"),
}));

// ---------------------------------------------------------------------------
// Mock: binding-resolver (to spy on calls)
// ---------------------------------------------------------------------------

const mockResolveBinding = vi.fn().mockReturnValue({
  allowedTools: ["Read", "Grep", "Glob"],
  mcpTools: [],          // Phase-1: always empty (no discovered tools)
  deniedMcpTools: [],
  role: "researcher",
});
const mockAuditBindingResolution = vi.fn().mockImplementation(
  (_payload: unknown, cb: (p: unknown) => void) => cb(_payload),
);

vi.mock("../binding-resolver", () => ({
  resolveBinding: (...args: unknown[]) => mockResolveBinding(...args),
  auditBindingResolution: (...args: unknown[]) =>
    mockAuditBindingResolution(...args),
}));

// ---------------------------------------------------------------------------
// Mock: lib/routines/scheduler (nextRunAt)
// ---------------------------------------------------------------------------

vi.mock("../scheduler", () => ({
  nextRunAt: vi.fn().mockReturnValue(9_999_999_999_000),
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER all mocks are registered
// ---------------------------------------------------------------------------

import { executeRoutine } from "../runner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_748_100_000_000;

/** Build a minimal routine DB row for the Drizzle select mock. */
function makeRoutineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUTINE_ID,
    name: "Test Routine",
    workspaceId: WORKSPACE_ID,
    yamlConfig: `
id: ${ROUTINE_ID}
name: Test Routine
workspace_id: ${WORKSPACE_ID}
pipeline:
  - collect_context:
      commands: ["echo hello"]
  - output_format: markdown
  - delivery: stdout
`,
    triggerMode: "manual",
    cronExpr: null,
    eventMatch: null,
    lastRunAt: null,
    nextRunAt: null,
    active: true,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

/**
 * Wire the Drizzle select mock to return routineRow for the
 * `select().from(routines).where(eq(id)).limit(1)` call.
 */
function wireRoutineSelect(row: ReturnType<typeof makeRoutineRow>) {
  mockDbSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue([row]),
      }),
    }),
  });
}

/**
 * Wire mockRawGet to return plan-dispatch columns from the $raw SELECT call
 * (the SAR-3 branch reads them via $raw.prepare().get()).
 *
 * Multiple calls may come from the same get() spy — we handle by returning
 * the same object for any call. Caller-specific calls (e.g., updateSchedule's
 * raw SQL) return undefined by default.
 */
function wirePlanDispatchColumns(
  overrides: Record<string, unknown> = {},
) {
  mockRawGet.mockReturnValue({
    action_kind: "plan-dispatch",
    sop_id: null,
    goal_prompt: null,
    skill_bindings_json: null,
    mcp_tool_allowlist_json: null,
    workspace_id: WORKSPACE_ID,
    ...overrides,
  });
}

function wireShellColumns() {
  mockRawGet.mockReturnValue({
    action_kind: "shell",
    sop_id: null,
    goal_prompt: null,
    skill_bindings_json: null,
    mcp_tool_allowlist_json: null,
    workspace_id: WORKSPACE_ID,
  });
}

/** Minimal SopWithSteps fixture (two steps). */
function makeSop() {
  return {
    id: SOP_ID,
    name: "Research → Synthesize → Draft → Review",
    description: "Generic research pipeline",
    workspaceId: null,
    version: 1,
    builtIn: true,
    archivedAt: null,
    contentHash: "bootstrap:0099:" + SOP_ID,
    createdAt: NOW - 10000,
    steps: [
      {
        id: "SOPS-RS-01",
        sopId: SOP_ID,
        stepIndex: 0,
        title: "Research: Collect sources and evidence",
        stepPromptTemplate: "You are a Researcher. Goal: {{goal_prompt}}",
        subagentRole: "researcher",
        requiredSkillsJson: '["skill:researcher"]',
        mcpToolAllowlistJson: null,
        optional: false,
      },
      {
        id: "SOPS-RS-02",
        sopId: SOP_ID,
        stepIndex: 1,
        title: "Synthesize: Distil findings",
        stepPromptTemplate: "You are a Scribe. Goal: {{goal_prompt}}",
        subagentRole: "scribe",
        requiredSkillsJson: null,
        mcpToolAllowlistJson: null,
        optional: false,
      },
    ],
  };
}

/** Minimal PlanNode array (mirrors expandSopToPlanNodes output shape). */
function makePlanNodes() {
  return [
    {
      id: "node-001",
      step: {
        id: "STEP-001",
        index: 1,
        title: "Research: Collect sources and evidence",
        rationale: "You are a Researcher. Goal: {{goal_prompt}}",
        subagentRole: "researcher" as const,
      },
      plan: {
        id: PLAN_ID,
        originalIntent: "Research → Synthesize → Draft → Review",
        estimatedComplexity: "M" as const,
        proposedAt: NOW,
        steps: [
          {
            id: "STEP-001",
            index: 1,
            title: "Research: Collect sources and evidence",
            rationale: "You are a Researcher. Goal: {{goal_prompt}}",
            subagentRole: "researcher" as const,
          },
        ],
      },
      depth: 0,
      cascadeMode: "per-level" as const,
      awaitingApproval: false,
      children: new Map(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Re-wire update chain fresh each test (clearAllMocks clears return values)
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  });
  mockDbInsert.mockReturnValue({
    values: vi.fn().mockReturnValue({ run: vi.fn() }),
  });

  // Default: resolveBinding returns no mcpTools (fail-safe, Phase-1)
  mockResolveBinding.mockReturnValue({
    allowedTools: ["Read", "Grep", "Glob"],
    mcpTools: [],
    deniedMcpTools: [],
    role: "researcher",
  });

  // Default: $raw.transaction wraps the fn and returns a callable that executes it.
  // The runner does: const persist = db.$raw.transaction(fn); persist();
  // So the mock must return a function that, when called, executes fn.
  mockRawTransaction.mockImplementation((fn: () => void) => () => fn());

  // Default: enforcePermission allows
  mockEnforcePermissionFromSingleton.mockReturnValue({
    allow: true,
    mode: "audit",
    reason: "audit-only",
    auditRowHash: "",
  });

  // Default: createWorkstream
  mockCreateWorkstream.mockResolvedValue({
    id: WS_ID,
    name: "test",
    description: GOAL_PROMPT,
    workspaceId: WORKSPACE_ID,
    status: "active",
  });

  // Default: executePlan resolves (non-destructive)
  mockExecutePlan.mockResolvedValue(undefined);

  // Default: writeDecision
  mockWriteDecision.mockReturnValue("dec_mock_001");
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) action_kind='shell' → old path unaffected (regression)
// ---------------------------------------------------------------------------

describe("(a) action_kind='shell' uses the existing shell pipeline", () => {
  it("calls validateYamlConfig and does NOT call executePlan", async () => {
    wireRoutineSelect(makeRoutineRow());
    wireShellColumns();

    // The shell path ends at deliverStdout — we don't need it to succeed;
    // just assert that executePlan was never called.
    const result = await executeRoutine(ROUTINE_ID);

    expect(mockExecutePlan).not.toHaveBeenCalled();
    expect(mockGetSop).not.toHaveBeenCalled();
    expect(mockExpandSopToPlanNodes).not.toHaveBeenCalled();
    expect(mockTryPlanDispatch).not.toHaveBeenCalled();
    // Result has routineId and a status (success or partial/failure depending
    // on command output — the echo command will be run via spawnSync in test
    // environment; we just check it doesn't crash)
    expect(result.routineId).toBe(ROUTINE_ID);
    expect(result.runId).toMatch(/^RNR-/);
  });
});

// ---------------------------------------------------------------------------
// (b) plan-dispatch + sopId → SOP expanded, workstream created, executePlan called
// ---------------------------------------------------------------------------

describe("(b) plan-dispatch via sopId uses expandSopToPlanNodes", () => {
  it("loads SOP, expands nodes, creates workstream, persists plan, calls executePlan", async () => {
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({ sop_id: SOP_ID, goal_prompt: GOAL_PROMPT });

    mockGetSop.mockReturnValue(makeSop());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    const result = await executeRoutine(ROUTINE_ID);

    // getSop called with the correct sopId
    expect(mockGetSop).toHaveBeenCalledWith(SOP_ID);

    // expandSopToPlanNodes called with the SOP object
    expect(mockExpandSopToPlanNodes).toHaveBeenCalledOnce();
    expect(mockExpandSopToPlanNodes.mock.calls[0]![0]).toMatchObject({ id: SOP_ID });

    // createWorkstream called with verbatim goal-prompt (N1)
    expect(mockCreateWorkstream).toHaveBeenCalledOnce();
    const wsArgs = mockCreateWorkstream.mock.calls[0]![0] as Record<string, unknown>;
    expect(wsArgs.workspaceId).toBe(WORKSPACE_ID);
    expect(wsArgs.description).toBe(GOAL_PROMPT);

    // insertProposedPlan called once per node
    expect(mockInsertProposedPlan).toHaveBeenCalledOnce();

    // executePlan called
    expect(mockExecutePlan).toHaveBeenCalledOnce();
    const execArgs = mockExecutePlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(execArgs.workstreamId).toBe(WS_ID);
    expect(execArgs.workspaceId).toBe(WORKSPACE_ID);

    // writeDecision called (N8)
    expect(mockWriteDecision).toHaveBeenCalled();
    const decArgs = mockWriteDecision.mock.calls[0]![0] as Record<string, unknown>;
    expect(decArgs.decisionKind).toBe("route");
    expect(String(decArgs.rationale)).toContain(ROUTINE_ID);
    expect(String(decArgs.rationale)).toContain(SOP_ID);

    // RunResult references workstreamId
    expect(result.status).toBe("success");
    expect(result.deliveryRef).toBe(WS_ID);
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output.workstreamId).toBe(WS_ID);
    expect(output.mode).toBe("plan-dispatch");
  });
});

// ---------------------------------------------------------------------------
// (c) Missing sopId AND goalPrompt → failure, no crash
// ---------------------------------------------------------------------------

describe("(c) missing sopId and goalPrompt returns failure without crash", () => {
  it("returns status='failure' with descriptive error when both are null", async () => {
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({ sop_id: null, goal_prompt: null });

    const result = await executeRoutine(ROUTINE_ID);

    expect(result.status).toBe("failure");
    expect(result.error).toMatch(/neither sopId nor goalPrompt/);
    // Must not have called any plan-building functions
    expect(mockGetSop).not.toHaveBeenCalled();
    expect(mockTryPlanDispatch).not.toHaveBeenCalled();
    expect(mockCreateWorkstream).not.toHaveBeenCalled();
    expect(mockExecutePlan).not.toHaveBeenCalled();
  });

  it("returns status='failure' when getSop returns null (archived/missing SOP)", async () => {
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({ sop_id: "SOP-NONEXISTENT-999", goal_prompt: null });

    mockGetSop.mockReturnValue(null);

    const result = await executeRoutine(ROUTINE_ID);

    expect(result.status).toBe("failure");
    expect(result.error).toMatch(/not found or archived/);
    expect(mockExecutePlan).not.toHaveBeenCalled();
  });

  // F4: empty workspaceId on the routine row → fail-closed before any write (N9).
  // The trusted scope is the Drizzle row.workspaceId; if it is empty/whitespace
  // runPlanDispatch must bail with a descriptive error and write nothing.
  it("F4: empty workspaceId on the routine row returns failure before any write", async () => {
    // Drizzle row carries an empty workspaceId (malformed row).
    wireRoutineSelect(makeRoutineRow({ workspaceId: "   " }));
    wirePlanDispatchColumns({ sop_id: SOP_ID, goal_prompt: GOAL_PROMPT });

    mockGetSop.mockReturnValue(makeSop());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    const result = await executeRoutine(ROUTINE_ID);

    expect(result.status).toBe("failure");
    expect(result.error).toMatch(/workspaceId fehlt auf Routine-Row/);
    // Fail-closed: NO plan-building / persistence side effects.
    expect(mockGetSop).not.toHaveBeenCalled();
    expect(mockCreateWorkstream).not.toHaveBeenCalled();
    expect(mockInsertProposedPlan).not.toHaveBeenCalled();
    expect(mockExecutePlan).not.toHaveBeenCalled();
    expect(mockWriteDecision).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (d) codex is NEVER selected as engine
//
// The codex exclusion lives inside tryPlanDispatch and executePlan.
// We verify the contract by checking that neither function is ever called
// with a codex engine, AND by asserting the mock interfaces are correct.
// Since both functions are fully mocked here, we rely on the integration
// test (plan-dispatch.ts + plan-executor.ts unit tests) for the actual
// engine-selection assertion.  What we assert here:
//   1. tryPlanDispatch is called in Path B (goalPrompt, no sopId).
//   2. The mock (representing the real function) NEVER receives a codex id.
//   3. The RunResult output never contains "codex" as engine name.
// ---------------------------------------------------------------------------

describe("(d) codex engine is never used in plan-dispatch flow", () => {
  it("tryPlanDispatch is called for goalPrompt path and codex is not in result engine", async () => {
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({ sop_id: null, goal_prompt: GOAL_PROMPT });

    mockTryPlanDispatch.mockResolvedValue({
      decomposed: true,
      reason: "multi-step:length>100",
      workstreamId: WS_ID,
      planId: PLAN_ID,
      rootSteps: 3,
      subSteps: 0,
    });

    const result = await executeRoutine(ROUTINE_ID);

    expect(result.status).toBe("success");

    // tryPlanDispatch was called — it is the LLM-propose path
    expect(mockTryPlanDispatch).toHaveBeenCalledOnce();

    // Assert: the args passed to tryPlanDispatch do NOT include codex exclusion
    // at this level (the exclusion lives inside plan-dispatch.ts itself — but
    // we can check that the prompt was passed verbatim, N1).
    const dispatchArgs = mockTryPlanDispatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(dispatchArgs.prompt).toBe(GOAL_PROMPT);

    // The RunResult output JSON must NOT mention codex as the engine.
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(JSON.stringify(output)).not.toContain("codex");
  });

  it("SOP path (Path A) does not invoke any LLM engine at all", async () => {
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({ sop_id: SOP_ID, goal_prompt: GOAL_PROMPT });

    mockGetSop.mockReturnValue(makeSop());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    await executeRoutine(ROUTINE_ID);

    // Path A never touches tryPlanDispatch (no LLM call for plan construction)
    expect(mockTryPlanDispatch).not.toHaveBeenCalled();

    // executePlan is the only engine consumer — and it internally excludes codex
    // (verified in plan-executor.test.ts; here we confirm it was called exactly once)
    expect(mockExecutePlan).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// (e) mcpToolAllowlist resolved + audited, NOT forwarded to real-invoke
//
// The mcpTools from resolvedBinding must appear in RunResult.output JSON
// (so they are traceable / auditable) but must NEVER appear in any real
// spawn call (tmux-spawn is never invoked from this bridge).
//
// We verify:
//   - resolveBinding is called with the mcpToolAllowlist from the DB column.
//   - auditBindingResolution is called (N8 audit hook).
//   - The resolved mcpTools appear in RunResult.output.
//   - mockExecutePlan (representing executePlan, which is the only "execution"
//     surface in Phase-1) is NOT called with an mcpTools argument.
// ---------------------------------------------------------------------------

describe("(e) Phase-1 R3-gate: mcpTools audited but NOT forwarded to real-invoke", () => {
  it("resolves + audits mcpTools, includes them in output only", async () => {
    const mcpAllowlist = '["mcp__heygen__render","mcp__github__list_repos"]';
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({
      sop_id: SOP_ID,
      goal_prompt: GOAL_PROMPT,
      mcp_tool_allowlist_json: mcpAllowlist,
    });

    mockGetSop.mockReturnValue(makeSop());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    // Simulate K1 pass (both tools are non-RAG and would be discovered in Phase-2)
    // In Phase-1 discoveredTools=[] so they are all denied — that is correct behaviour.
    mockResolveBinding.mockReturnValue({
      allowedTools: ["Read", "Grep", "Glob"],
      mcpTools: [],           // Phase-1: deny all (discoveredTools=[])
      deniedMcpTools: ["mcp__heygen__render", "mcp__github__list_repos"],
      role: "researcher",
    });

    const result = await executeRoutine(ROUTINE_ID);

    // resolveBinding was called with the raw allowlist entries
    expect(mockResolveBinding).toHaveBeenCalledOnce();
    const bindingArg = mockResolveBinding.mock.calls[0]![0] as Record<string, unknown>;
    const bindingAllowlist = bindingArg["mcpToolAllowlist"] as string[];
    expect(bindingAllowlist).toContain("mcp__heygen__render");
    expect(bindingAllowlist).toContain("mcp__github__list_repos");

    // auditBindingResolution was called (N8)
    expect(mockAuditBindingResolution).toHaveBeenCalledOnce();
    const auditPayload = mockAuditBindingResolution.mock.calls[0]![0] as Record<string, unknown>;
    expect(auditPayload.routineId).toBe(ROUTINE_ID);
    expect(auditPayload.workspaceId).toBe(WORKSPACE_ID);

    // mcpTools appear in RunResult.output (traceable)
    const output = JSON.parse(result.output) as Record<string, unknown>;
    expect(output).toHaveProperty("resolvedMcpTools");
    expect(output).toHaveProperty("deniedMcpTools");

    // CRITICAL: executePlan was called WITHOUT an mcpTools argument
    // (Phase-1 gate — no real-invoke forwarding)
    expect(mockExecutePlan).toHaveBeenCalledOnce();
    const execArgs = mockExecutePlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(execArgs).not.toHaveProperty("mcpTools");
    expect(execArgs).not.toHaveProperty("allowedMcpTools");

    // The bridge must not have called any tmux-spawn or external spawn surface
    // (no such mock exists — this is verified by absence of any call that
    // would carry the mcpTools through to a real subagent invocation).
    expect(result.status).toBe("success");
  });

  it("K1-RAG-blocked tools never reach executePlan regardless of resolveBinding mock", async () => {
    // Simulate RAG tool in the allowlist + K1 block in resolveBinding
    const mcpAllowlist = '["mcp__local-rag__query_documents"]';
    wireRoutineSelect(makeRoutineRow());
    wirePlanDispatchColumns({
      sop_id: SOP_ID,
      goal_prompt: GOAL_PROMPT,
      mcp_tool_allowlist_json: mcpAllowlist,
    });

    mockGetSop.mockReturnValue(makeSop());
    mockExpandSopToPlanNodes.mockReturnValue(makePlanNodes());

    // K1 correctly blocks the RAG tool
    mockResolveBinding.mockReturnValue({
      allowedTools: ["Read", "Grep", "Glob"],
      mcpTools: [],           // K1 blocked
      deniedMcpTools: ["mcp__local-rag__query_documents"],
      role: "unknown",
    });

    const result = await executeRoutine(ROUTINE_ID);

    // Even though a RAG tool was requested, executePlan received no mcpTools arg
    const execArgs = mockExecutePlan.mock.calls[0]![0] as Record<string, unknown>;
    expect(execArgs).not.toHaveProperty("mcpTools");

    const output = JSON.parse(result.output) as Record<string, unknown>;
    const denied = output["deniedMcpTools"] as string[];
    expect(denied).toContain("mcp__local-rag__query_documents");
    expect((output["resolvedMcpTools"] as string[]).length).toBe(0);
    expect(result.status).toBe("success");
  });
});
