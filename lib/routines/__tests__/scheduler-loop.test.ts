/**
 * lib/routines/__tests__/scheduler-loop.test.ts
 *
 * Vitest unit-tests for sweepDueRoutines().
 *
 * Strategie: DB und runner werden per vi.mock() isoliert.
 * Der resourcePool ist ein echtes Modul-Singleton — wir nutzen
 * resourcePool.__reset() vor/nach jedem Test (Muster aus spawner.test.ts).
 *
 * Tests:
 *   (a) fällige Routine wird gefeuert + nextRunAt wird neu gesetzt
 *   (b) Slot-Erschöpfung → defer, nicht feuern, kein Drop
 *   (c) ein Fire wirft → andere laufen trotzdem, Fehler gesammelt
 *   (d) nicht-fällige Routine (nextRunAt in Zukunft) wird ignoriert
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from "vitest";

import { resourcePool } from "../../agents/resource-pool";

// ---------------------------------------------------------------------------
// Mock: db/client
// ---------------------------------------------------------------------------

const mockDbUpdate = vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ run: vi.fn() }) }) });
const mockSelect = vi.fn();

vi.mock("../../../db/client", () => ({
  getDb: () => ({
    select: mockSelect,
    update: mockDbUpdate,
  }),
}));

// ---------------------------------------------------------------------------
// Mock: db/schema/routines (re-export identity so Drizzle column refs work)
// ---------------------------------------------------------------------------

vi.mock("../../../db/schema/routines", () => ({
  routines: {
    id: "id",
    active: "active",
    triggerMode: "trigger_mode",
    cronExpr: "cron_expr",
    nextRunAt: "next_run_at",
    actionKind: "action_kind",
  },
}));

// ---------------------------------------------------------------------------
// Mock: drizzle-orm (and/eq/isNotNull/lte — used in the WHERE builder)
// We just need them to be pass-through markers so the mock DB chain works.
// ---------------------------------------------------------------------------

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ _op: "and", args }),
  eq: (col: unknown, val: unknown) => ({ _op: "eq", col, val }),
  isNotNull: (col: unknown) => ({ _op: "isNotNull", col }),
  lte: (col: unknown, val: unknown) => ({ _op: "lte", col, val }),
}));

// ---------------------------------------------------------------------------
// Mock: runner (executeRoutine)
// ---------------------------------------------------------------------------

import type { RunResult } from "../types";

const mockExecuteRoutine: MockedFunction<(id: string, opts?: unknown) => Promise<RunResult>> = vi.fn();

vi.mock("../runner", () => ({
  executeRoutine: (...args: Parameters<typeof mockExecuteRoutine>) =>
    mockExecuteRoutine(...args),
}));

// ---------------------------------------------------------------------------
// Mock: scheduler (nextRunAt) — returns a fixed future time
// ---------------------------------------------------------------------------

// vi.hoisted: the mock factory below is hoisted above this file's top-level
// consts by Vitest. A plain `const FIXED_NEXT` would be in the temporal dead
// zone when the (eagerly-evaluated) factory reads it. vi.hoisted lifts the
// value alongside the mock so it is initialised first.
const { FIXED_NEXT } = vi.hoisted(() => ({ FIXED_NEXT: 9_999_999_999_000 }));
vi.mock("../scheduler", () => ({
  nextRunAt: vi.fn().mockReturnValue(FIXED_NEXT),
}));

// ---------------------------------------------------------------------------
// Import SUT AFTER mocks are registered (Vitest hoisting ensures this)
// ---------------------------------------------------------------------------

import { sweepDueRoutines, __resetRunningGuard } from "../scheduler-loop";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_748_000_000_000; // fixed epoch for deterministic tests

function makeRunResult(
  routineId: string,
  status: RunResult["status"] = "success",
  error?: string,
): RunResult {
  return {
    runId: `RNR-${routineId}`,
    routineId,
    status,
    startedAt: NOW,
    finishedAt: NOW + 100,
    output: "ok",
    error,
  };
}

interface DueRowInput {
  id: string;
  cronExpr: string | null;
  nextRunAt: number | null;
  actionKind?: string;
}

/** Wire mockSelect to resolve with the given rows via the Drizzle chain. */
function wireSelectRows(rows: DueRowInput[]) {
  const normalised = rows.map((r) => ({ actionKind: "shell", ...r }));
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(normalised),
    }),
  });
}

/**
 * Wire mockSelect so the first sweep sees `firstRows`, the second sees
 * `secondRows`. Used by test (f) to model "same routine still due on the
 * immediately following sweep".
 */
function wireSelectSequence(firstRows: DueRowInput[], secondRows: DueRowInput[]) {
  const norm = (rows: DueRowInput[]) => rows.map((r) => ({ actionKind: "shell", ...r }));
  mockSelect
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(norm(firstRows)) }),
    })
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(norm(secondRows)) }),
    });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  resourcePool.__reset();
  __resetRunningGuard();
  vi.clearAllMocks();
  // Re-wire update chain fresh each test (clearAllMocks clears return values)
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  });
});

afterEach(() => {
  resourcePool.__reset();
  __resetRunningGuard();
});

// ---------------------------------------------------------------------------
// (a) Fällige Routine wird gefeuert + nextRunAt wird neu gesetzt
// ---------------------------------------------------------------------------

describe("(a) due routine is fired and schedule advanced", () => {
  it("fires a single due routine and advances next_run_at", async () => {
    const routineId = "RTN-a001";
    wireSelectRows([{ id: routineId, cronExpr: "0 8 * * *", nextRunAt: NOW - 1 }]);
    mockExecuteRoutine.mockResolvedValueOnce(makeRunResult(routineId, "success"));

    const result = await sweepDueRoutines(NOW);

    // Correct candidate count
    expect(result.candidateCount).toBe(1);
    // Fired exactly once
    expect(result.firedCount).toBe(1);
    expect(result.deferredCount).toBe(0);
    expect(result.failedCount).toBe(0);
    // executeRoutine called with skipScheduleUpdate=true (we manage it)
    expect(mockExecuteRoutine).toHaveBeenCalledOnce();
    expect(mockExecuteRoutine).toHaveBeenCalledWith(routineId, {
      trigger: "cron",
      skipScheduleUpdate: true,
    });
    // Run record present
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.routineId).toBe(routineId);
    // Schedule was updated (db.update called)
    expect(mockDbUpdate).toHaveBeenCalled();
    // No errors
    expect(result.errors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// (b) Slot erschöpft → defer, kein Fire, kein Drop
// ---------------------------------------------------------------------------

describe("(b) slot exhaustion defers without dropping", () => {
  it("defers all candidates when pool is full (heavyTotal=2 already occupied)", async () => {
    // Fill the pool to capacity: 2 heavy slots
    const slotA = await resourcePool.acquireSlot({
      kind: "ollama-heavy",
      subagentId: "blocker-a",
      priority: "normal",
    });
    const slotB = await resourcePool.acquireSlot({
      kind: "claude-cli",
      subagentId: "blocker-b",
      priority: "normal",
    });
    // Both slots acquired — heavyTotal=2 is now exhausted
    expect(resourcePool.getInflight()).toHaveLength(2);

    // Two due candidates: BOTH must defer, none may fire or drop.
    wireSelectRows([
      { id: "RTN-b001", cronExpr: "* * * * *", nextRunAt: NOW - 1 },
      { id: "RTN-b002", cronExpr: "* * * * *", nextRunAt: NOW - 1 },
    ]);

    // Regression guard: with the old acquireSlot({ timeoutMs: 0 }) path the
    // waiter queued forever and this await never resolved (5s vitest timeout).
    // tryAcquireSlot returns null synchronously, so the sweep completes at once.
    const result = await sweepDueRoutines(NOW);

    // Both candidates found but deferred, not fired
    expect(result.candidateCount).toBe(2);
    expect(result.deferredCount).toBe(2);
    expect(result.firedCount).toBe(0);
    // executeRoutine MUST NOT have been called
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
    // Schedule NOT advanced (next_run_at stays unchanged so retry happens next tick)
    expect(mockDbUpdate).not.toHaveBeenCalled();
    // No errors
    expect(result.errors).toEqual({});
    // Pool was not polluted by failed acquires (still exactly the 2 blockers)
    expect(resourcePool.getInflight()).toHaveLength(2);

    // Cleanup slots
    resourcePool.releaseSlot(slotA.slotId);
    resourcePool.releaseSlot(slotB.slotId);
  });
});

// ---------------------------------------------------------------------------
// (c) One fire throws → siblings run, errors collected
// ---------------------------------------------------------------------------

describe("(c) one failing fire does not block siblings", () => {
  it("continues with remaining routines when one executeRoutine throws", async () => {
    const id1 = "RTN-c001";
    const id2 = "RTN-c002";
    const id3 = "RTN-c003";

    wireSelectRows([
      { id: id1, cronExpr: "0 * * * *", nextRunAt: NOW - 1 },
      { id: id2, cronExpr: "0 * * * *", nextRunAt: NOW - 1 },
      { id: id3, cronExpr: "0 * * * *", nextRunAt: NOW - 1 },
    ]);

    // id2 throws unexpectedly; others succeed
    mockExecuteRoutine
      .mockResolvedValueOnce(makeRunResult(id1, "success"))
      .mockRejectedValueOnce(new Error("simulated crash"))
      .mockResolvedValueOnce(makeRunResult(id3, "success"));

    const result = await sweepDueRoutines(NOW);

    expect(result.candidateCount).toBe(3);
    // All three were "fired" (attempted) — even the crashing one
    expect(result.firedCount).toBe(3);
    expect(result.deferredCount).toBe(0);
    expect(result.failedCount).toBe(1);
    // Error recorded for id2 only
    expect(result.errors).toHaveProperty(id2, "simulated crash");
    expect(result.errors).not.toHaveProperty(id1);
    expect(result.errors).not.toHaveProperty(id3);
    // Two successful runs in result
    const successRuns = result.runs.filter((r) => r.status === "success");
    expect(successRuns).toHaveLength(2);
    // Schedule advanced for all three
    expect(mockDbUpdate).toHaveBeenCalledTimes(3);
  });

  it("collects failure status from executeRoutine when it returns failure", async () => {
    const routineId = "RTN-c004";
    wireSelectRows([{ id: routineId, cronExpr: "0 * * * *", nextRunAt: NOW - 1 }]);
    mockExecuteRoutine.mockResolvedValueOnce(
      makeRunResult(routineId, "failure", "delivery broke"),
    );

    const result = await sweepDueRoutines(NOW);

    expect(result.firedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.errors[routineId]).toBe("delivery broke");
    // Schedule still advanced
    expect(mockDbUpdate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// (d) Non-due routine (nextRunAt in the future) is ignored
// ---------------------------------------------------------------------------

describe("(d) non-due routines are ignored", () => {
  it("returns zero candidates when all routines have future nextRunAt", async () => {
    // The WHERE clause filters nextRunAt <= now — so our mock returns empty.
    wireSelectRows([]);

    const result = await sweepDueRoutines(NOW);

    expect(result.candidateCount).toBe(0);
    expect(result.firedCount).toBe(0);
    expect(result.deferredCount).toBe(0);
    expect(mockExecuteRoutine).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("fires only the due routine when mixed with a future one", async () => {
    const dueId = "RTN-d001";
    // Only the due row passes the SQL WHERE filter — mock returns just the due one
    wireSelectRows([{ id: dueId, cronExpr: "5 4 * * *", nextRunAt: NOW - 60_000 }]);
    mockExecuteRoutine.mockResolvedValueOnce(makeRunResult(dueId, "success"));

    const result = await sweepDueRoutines(NOW);

    expect(result.candidateCount).toBe(1);
    expect(result.firedCount).toBe(1);
    expect(mockExecuteRoutine).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// (e) BLOCKER A — plan-dispatch must NOT hold the scheduler slot across exec
// ---------------------------------------------------------------------------

describe("(e) plan-dispatch releases the admission token before executing", () => {
  it("does not hold an ollama-heavy slot while executeRoutine runs (plan-dispatch self-gates)", async () => {
    const routineId = "RTN-e001";
    wireSelectRows([
      {
        id: routineId,
        cronExpr: "*/1 * * * *",
        nextRunAt: NOW - 1,
        actionKind: "plan-dispatch",
      },
    ]);

    // Observe the pool state from INSIDE executeRoutine. If the scheduler
    // were holding its admission token across the await (the BLOCKER A bug),
    // there would be 1 inflight ollama-heavy slot here — and executePlan's own
    // per-step acquire would race against heavyTotal=2, risking deadlock.
    let inflightDuringExec = -1;
    let ollamaHeavyDuringExec = -1;
    mockExecuteRoutine.mockImplementationOnce(async () => {
      const inflight = resourcePool.getInflight();
      inflightDuringExec = inflight.length;
      ollamaHeavyDuringExec = inflight.filter((s) => s.kind === "ollama-heavy").length;
      // Simulate executePlan acquiring its OWN per-step slots — this must
      // succeed because the scheduler already gave its token back.
      const stepSlot = await resourcePool.acquireSlot({
        kind: "ollama-heavy",
        subagentId: "executePlan-step-1",
        priority: "normal",
        timeoutMs: 1_000,
      });
      resourcePool.releaseSlot(stepSlot.slotId);
      return makeRunResult(routineId, "success");
    });

    const result = await sweepDueRoutines(NOW);

    // The routine fired successfully...
    expect(result.firedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    // ...and crucially: the scheduler held ZERO slots during execution.
    expect(ollamaHeavyDuringExec).toBe(0);
    expect(inflightDuringExec).toBe(0);
    // After the sweep the pool is fully drained (no leaked token).
    expect(resourcePool.getInflight()).toHaveLength(0);
    // Schedule was advanced (optimistically, before exec).
    expect(mockDbUpdate).toHaveBeenCalledOnce();
  });

  it("shell routines DO hold the slot across execution (no self-gating)", async () => {
    const routineId = "RTN-e002";
    wireSelectRows([
      { id: routineId, cronExpr: "*/1 * * * *", nextRunAt: NOW - 1, actionKind: "shell" },
    ]);

    let ollamaHeavyDuringExec = -1;
    mockExecuteRoutine.mockImplementationOnce(async () => {
      ollamaHeavyDuringExec = resourcePool
        .getInflight()
        .filter((s) => s.kind === "ollama-heavy").length;
      return makeRunResult(routineId, "success");
    });

    const result = await sweepDueRoutines(NOW);

    expect(result.firedCount).toBe(1);
    // shell holds the scheduler token for the duration of executeRoutine.
    expect(ollamaHeavyDuringExec).toBe(1);
    // Released afterwards.
    expect(resourcePool.getInflight()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (f) BLOCKER B — optimistic next_run_at advance + running-guard prevent stack
// ---------------------------------------------------------------------------

describe("(f) optimistic advance + running-guard prevent double-fire", () => {
  it("advances next_run_at BEFORE awaiting the fire (optimistic)", async () => {
    const routineId = "RTN-f001";
    wireSelectRows([
      { id: routineId, cronExpr: "*/1 * * * *", nextRunAt: NOW - 1, actionKind: "shell" },
    ]);

    // Capture whether the schedule was advanced by the time exec is observed.
    let advancedBeforeExec = false;
    mockExecuteRoutine.mockImplementationOnce(async () => {
      // mockDbUpdate is the schedule-advance write. If it was called before
      // executeRoutine was awaited, the routine has already left the due-set.
      advancedBeforeExec = mockDbUpdate.mock.calls.length > 0;
      return makeRunResult(routineId, "success");
    });

    const result = await sweepDueRoutines(NOW);

    expect(result.firedCount).toBe(1);
    expect(advancedBeforeExec).toBe(true);
  });

  it("running-guard skips a re-entrant fire of a routine already in flight", async () => {
    const longRunId = "RTN-f002";

    // First sweep starts a long-running fire. We hold executeRoutine open via
    // a deferred promise so a SECOND sweep can run concurrently while the
    // routine is still "in flight".
    let releaseExec!: () => void;
    const execGate = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });

    // Both sweeps will see the same due routine (still due because exec is slow
    // and — in this test — the second sweep observes the row before the write
    // settles; the running-guard is the protection under test, not the cron math).
    wireSelectSequence(
      [{ id: longRunId, cronExpr: "*/1 * * * *", nextRunAt: NOW - 1, actionKind: "shell" }],
      [{ id: longRunId, cronExpr: "*/1 * * * *", nextRunAt: NOW - 1, actionKind: "shell" }],
    );

    let execCallCount = 0;
    mockExecuteRoutine.mockImplementation(async () => {
      execCallCount += 1;
      await execGate; // block until released
      return makeRunResult(longRunId, "success");
    });

    // Kick off sweep #1 (does not resolve yet — exec is gated).
    const sweep1 = sweepDueRoutines(NOW);
    // Yield a microtask so sweep #1 enters executeRoutine and marks the guard.
    await Promise.resolve();
    await Promise.resolve();

    // Sweep #2 runs while the routine is in flight. The running-guard must
    // skip it as deferred — NOT fire a second concurrent executeRoutine.
    const result2 = await sweepDueRoutines(NOW);

    expect(result2.candidateCount).toBe(1);
    expect(result2.deferredCount).toBe(1);
    expect(result2.firedCount).toBe(0);

    // Now let sweep #1 finish.
    releaseExec();
    const result1 = await sweep1;
    expect(result1.firedCount).toBe(1);

    // executeRoutine was invoked EXACTLY once across both overlapping sweeps.
    expect(execCallCount).toBe(1);

    // Reset the shared mock implementation for subsequent tests.
    mockExecuteRoutine.mockReset();
  });
});
