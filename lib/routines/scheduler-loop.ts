/**
 * lib/routines/scheduler-loop — in-process cron scheduler loop.
 *
 * sweepDueRoutines() is the only public entry point.
 * It is called by:
 *   1. instrumentation.ts  — 45 s after boot + every 60 s (setInterval, in the
 *      Node process, fire-and-forget).  Process locality is MANDATORY here:
 *      broadcastEvent() and the resourcePool are pure in-memory singletons
 *      (module scope); an external cURL cron cannot trigger them.
 *   2. /api/heartbeat/tick  — belt and suspenders for the systemd timer.
 *
 * N11 slot gate (ADMISSION-TOKEN model):
 *   tryAcquireSlot('ollama-heavy', background) is a NON-blocking
 *   admission token: full pool → defer (next_run_at stays → retry next
 *   tick).  No drop, no jam.  HOW the token is held afterwards depends
 *   on the action_kind:
 *
 *     - action_kind='shell'         → no self-gating in the runner; we HOLD
 *       the slot across the entire executeRoutine execution (releaseSlot in the
 *       finally).
 *     - action_kind='plan-dispatch' → executePlan() acquires resourcePool.acquireSlot
 *       itself PER STEP.  If we held the scheduler slot across the
 *       await, ONE plan-dispatch routine would occupy 2 slots; two
 *       simultaneous ones → deadlock until acquireSlot timeout (BLOCKER A).  So
 *       we release the admission token IMMEDIATELY BEFORE the await —
 *       executePlan then self-gates alone against the N11 budget.
 *
 * Dispatch lock / anti-stacking (BLOCKER B):
 *   (1) Optimistic next_run_at advance BEFORE the fire: as soon as we decide to
 *       fire, we write next_run_at = nextRunAt(cron, now).
 *       A 240-s plan-dispatch routine at cron `* /1` thereby leaves the
 *       due set immediately — the next 60-s sweep no longer sees it as due.
 *   (2) In-process running guard: a module-scope Set<string> with currently
 *       running routineIds.  If the id is already in it → skip (counted as
 *       deferred).  Protects against re-entrancy when the instrumentation interval AND
 *       /api/heartbeat/tick fire in parallel.  Removed again in the finally.
 *
 * Error isolation:
 *   try/catch per routine; one error does NOT abort the others; all errors
 *   land in SweepResult.errors.
 *
 * Schedule-update strategy:
 *   skipScheduleUpdate=true at executeRoutine — we manage last_run_at /
 *   next_run_at OURSELVES (optimistically, see above), thus avoiding a double
 *   write.  On error the optimistic advance stays (no
 *   endless retry of the same minute).
 */

import { and, eq, isNotNull, lte } from "drizzle-orm";

import { getDb } from "../../db/client";
import { routines } from "../../db/schema/routines";
import { resourcePool } from "../agents/resource-pool";
import { nextRunAt } from "./scheduler";
import { executeRoutine } from "./runner";
import type { RunResult } from "./types";

// ---------------------------------------------------------------------------
// In-process running guard (module scope, process-local)
// ---------------------------------------------------------------------------

/**
 * routineIds that are RIGHT NOW in the middle of a fire.  Re-entrancy protection
 * against parallel sweep callers (instrumentation interval + heartbeat tick).
 * Process-local — exactly like resourcePool, an in-memory singleton.
 */
const inflightRoutineIds = new Set<string>();

/** TEST-ONLY — clears the running guard between tests. */
export function __resetRunningGuard(): void {
  inflightRoutineIds.clear();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SweepResult {
  /** Epoch-ms of the sweep. */
  sweptAt: number;
  /** Number of routines with nextRunAt <= now (before the slot gate). */
  candidateCount: number;
  /** Number of successfully fired routines. */
  firedCount: number;
  /** Number of deferred routines (no free slot OR already running). */
  deferredCount: number;
  /** Number of routines that were fired but failed. */
  failedCount: number;
  /** Run records of all fired routines (success + failure). */
  runs: RunResult[];
  /** Errors per routine (routineId → message). */
  errors: Record<string, string>;
}

interface DueRow {
  id: string;
  cronExpr: string | null;
  nextRunAt: number | null;
  actionKind: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Writes last_run_at + next_run_at.  `now` = fire time; next is computed from
 * the cron expression relative to now.  Non-fatal — errors are
 * logged and swallowed (a DB write error must not kill the sweep).
 */
function advanceSchedule(routineId: string, cronExpr: string | null, now: number): void {
  try {
    const db = getDb();
    const next = cronExpr ? nextRunAt(cronExpr, now) : null;
    db.update(routines)
      .set({
        lastRunAt: now,
        nextRunAt: next,
        updatedAt: Date.now(),
      })
      .where(eq(routines.id, routineId))
      .run();
  } catch (err) {
    process.stderr.write(
      `[routine-scheduler] schedule-update failed id=${routineId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// sweepDueRoutines
// ---------------------------------------------------------------------------

/**
 * Finds all due cron routines (active=1, triggerMode='cron',
 * nextRunAt IS NOT NULL, nextRunAt <= now) and fires them under N11-budget
 * control.  Non-fatal, fire-and-forget-friendly.
 *
 * @param now  Unix epoch in ms.  Default: Date.now().  Only override in tests.
 */
export async function sweepDueRoutines(now: number = Date.now()): Promise<SweepResult> {
  const result: SweepResult = {
    sweptAt: now,
    candidateCount: 0,
    firedCount: 0,
    deferredCount: 0,
    failedCount: 0,
    runs: [],
    errors: {},
  };

  let dueRows: DueRow[];

  try {
    const db = getDb();
    dueRows = await db
      .select({
        id: routines.id,
        cronExpr: routines.cronExpr,
        nextRunAt: routines.nextRunAt,
        actionKind: routines.actionKind,
      })
      .from(routines)
      .where(
        and(
          eq(routines.active, true),
          eq(routines.triggerMode, "cron"),
          isNotNull(routines.nextRunAt),
          lte(routines.nextRunAt, now),
        ),
      );
  } catch (err) {
    // DB error on the SELECT → fire nothing, but do not crash.
    process.stderr.write(
      `[routine-scheduler] SELECT failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return result;
  }

  result.candidateCount = dueRows.length;

  if (dueRows.length === 0) return result;

  process.stderr.write(
    `[routine-scheduler] sweep at ${new Date(now).toISOString()} — ${dueRows.length} candidate(s)\n`,
  );

  for (const row of dueRows) {
    const routineId = row.id;
    const isPlanDispatch = row.actionKind === "plan-dispatch";

    // ------------------------------------------------------------------
    // BLOCKER B (2) — in-process running guard.
    // Already a running fire of the same routine? → skip (deferred).
    // Protects against re-entrancy when a second sweep comes in parallel
    // (instrumentation interval + heartbeat tick).
    // ------------------------------------------------------------------
    if (inflightRoutineIds.has(routineId)) {
      result.deferredCount += 1;
      process.stderr.write(
        `[routine-scheduler] deferred id=${routineId} (already running — re-entrancy guard)\n`,
      );
      continue;
    }

    // ------------------------------------------------------------------
    // N11 admission token: SYNCHRONOUS, non-blocking.
    // tryAcquireSlot returns null immediately when no budget is free —
    // no queuing, no await, no hanging.
    // ------------------------------------------------------------------
    const slot = resourcePool.tryAcquireSlot({
      kind: "ollama-heavy",
      subagentId: `routine-scheduler:${routineId}`,
      priority: "background",
    });
    if (slot === null) {
      // No slot free — defer, do not drop.  next_run_at stays unchanged.
      result.deferredCount += 1;
      process.stderr.write(
        `[routine-scheduler] deferred id=${routineId} (no slot available)\n`,
      );
      continue;
    }

    // ------------------------------------------------------------------
    // We have decided to fire.  FROM HERE:
    //  - mark the running guard (remove in the finally).
    //  - BLOCKER B (1): advance next_run_at OPTIMISTICALLY, BEFORE we await.
    //    A 240-s routine thereby leaves the due set immediately.
    // ------------------------------------------------------------------
    inflightRoutineIds.add(routineId);
    advanceSchedule(routineId, row.cronExpr, now);

    // ------------------------------------------------------------------
    // BLOCKER A — admission-token lifetime depends on the action_kind.
    // plan-dispatch: executePlan() self-gates PER STEP against the N11 budget.
    //   → release the token NOW (before the await), otherwise double-slot/deadlock.
    // shell: no self-gating → hold the token across the execution.
    // ------------------------------------------------------------------
    let slotReleased = false;
    const releaseOnce = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      resourcePool.releaseSlot(slot.slotId);
    };
    if (isPlanDispatch) {
      releaseOnce();
      process.stderr.write(
        `[routine-scheduler] admission-token released pre-exec id=${routineId} (plan-dispatch self-gates)\n`,
      );
    }

    // ------------------------------------------------------------------
    // Fire the routine.  executeRoutine() is non-throwing by contract, but
    // we wrap anyway to protect sibling routines against any unexpected throw.
    // skipScheduleUpdate=true: we have already done the advance (optimistically).
    // ------------------------------------------------------------------
    try {
      const runResult = await executeRoutine(routineId, {
        trigger: "cron",
        skipScheduleUpdate: true,
      });
      result.runs.push(runResult);
      result.firedCount += 1;

      if (runResult.status === "failure") {
        result.failedCount += 1;
        result.errors[routineId] = runResult.error ?? "unknown failure";
        process.stderr.write(
          `[routine-scheduler] failed id=${routineId} error=${runResult.error ?? "?"}\n`,
        );
      } else {
        process.stderr.write(
          `[routine-scheduler] fired id=${routineId} status=${runResult.status} run=${runResult.runId}\n`,
        );
      }
    } catch (err) {
      // executeRoutine should never throw, but belt-and-suspenders.
      result.failedCount += 1;
      result.firedCount += 1; // We attempted it — count it.
      const msg = err instanceof Error ? err.message : String(err);
      result.errors[routineId] = msg;
      process.stderr.write(
        `[routine-scheduler] failed id=${routineId} (unexpected throw): ${msg}\n`,
      );
    } finally {
      // shell: release the token only here (held across the execution).
      // plan-dispatch: already released before the await → releaseOnce no-op.
      releaseOnce();
      inflightRoutineIds.delete(routineId);
    }
  }

  process.stderr.write(
    `[routine-scheduler] done — fired=${result.firedCount} deferred=${result.deferredCount} failed=${result.failedCount}\n`,
  );

  return result;
}
