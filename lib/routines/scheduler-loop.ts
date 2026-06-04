/**
 * lib/routines/scheduler-loop — In-Process Cron-Scheduler-Loop.
 *
 * sweepDueRoutines() ist der einzige öffentliche Entry-Point.
 * Sie wird aufgerufen von:
 *   1. instrumentation.ts  — 45 s nach Boot + alle 60 s (setInterval, im
 *      Node-Prozess, fire-and-forget).  Prozess-Lokalität ist hier ZWINGEND:
 *      broadcastEvent() und der resourcePool sind reine In-Memory-Singletons
 *      (Module-Scope); ein externer cURL-Cron kann diese nicht triggern.
 *   2. /api/heartbeat/tick  — belt-and-suspenders für systemd-Timer.
 *
 * N11-Slot-Gate (ADMISSION-TOKEN-Modell):
 *   tryAcquireSlot('ollama-heavy', background) ist ein NICHT-blockierender
 *   Admission-Token: voller Pool → defer (next_run_at bleibt → Retry nächster
 *   Tick).  Kein Drop, kein Stau.  WIE der Token danach gehalten wird, hängt
 *   vom action_kind ab:
 *
 *     - action_kind='shell'         → kein Self-Gating im Runner; wir HALTEN
 *       den Slot über die gesamte executeRoutine-Ausführung (releaseSlot im
 *       finally).
 *     - action_kind='plan-dispatch' → executePlan() acquired PRO STEP selbst
 *       resourcePool.acquireSlot.  Würden wir den Scheduler-Slot über das
 *       await halten, belegte EINE plan-dispatch-Routine 2 Slots; zwei
 *       gleichzeitige → Deadlock bis acquireSlot-Timeout (BLOCKER A).  Deshalb
 *       geben wir den Admission-Token SOFORT VOR dem await wieder frei —
 *       executePlan self-gated dann allein gegen das N11-Budget.
 *
 * Dispatch-Lock / Anti-Stacking (BLOCKER B):
 *   (1) Optimistisches next_run_at-Advance VOR dem Fire: sobald wir uns zum
 *       Feuern entscheiden, schreiben wir next_run_at = nextRunAt(cron, now).
 *       Eine 240-s-plan-dispatch-Routine bei cron `* /1` verlässt damit sofort
 *       die Due-Menge — der nächste 60-s-Sweep sieht sie nicht mehr als fällig.
 *   (2) In-Process-Running-Guard: ein modul-scope Set<string> mit aktuell
 *       laufenden routineIds.  Ist die id schon drin → skip (als deferred
 *       gezählt).  Schützt gegen Re-Entrancy wenn instrumentation-Interval UND
 *       /api/heartbeat/tick parallel feuern.  Im finally wieder entfernt.
 *
 * Fehler-Isolation:
 *   try/catch pro Routine; ein Fehler bricht die anderen NICHT ab; alle Fehler
 *   landen in SweepResult.errors.
 *
 * Schedule-Update-Strategie:
 *   skipScheduleUpdate=true an executeRoutine — wir verwalten last_run_at /
 *   next_run_at SELBST (optimistisch, s.o.), und vermeiden so einen doppelten
 *   Write.  Bei Fehler bleibt das optimistische Advance bestehen (kein
 *   Endlos-Retry derselben Minute).
 */

import { and, eq, isNotNull, lte } from "drizzle-orm";

import { getDb } from "../../db/client";
import { routines } from "../../db/schema/routines";
import { resourcePool } from "../agents/resource-pool";
import { nextRunAt } from "./scheduler";
import { executeRoutine } from "./runner";
import type { RunResult } from "./types";

// ---------------------------------------------------------------------------
// In-Process Running-Guard (Modul-Scope, Prozess-lokal)
// ---------------------------------------------------------------------------

/**
 * routineIds die JETZT mitten in einem Fire stecken.  Re-Entrancy-Schutz
 * gegen parallele Sweep-Aufrufer (instrumentation-Interval + heartbeat-tick).
 * Prozess-lokal — exakt wie resourcePool ein In-Memory-Singleton.
 */
const inflightRoutineIds = new Set<string>();

/** TEST-ONLY — leert den Running-Guard zwischen Tests. */
export function __resetRunningGuard(): void {
  inflightRoutineIds.clear();
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SweepResult {
  /** Epoch-ms des Sweeps. */
  sweptAt: number;
  /** Anzahl der Routinen mit nextRunAt <= now (vor Slot-Gate). */
  candidateCount: number;
  /** Anzahl erfolgreich gefeuerter Routinen. */
  firedCount: number;
  /** Anzahl deferrierter Routinen (kein freier Slot ODER bereits laufend). */
  deferredCount: number;
  /** Anzahl Routinen die gefeuert wurden aber fehlschlugen. */
  failedCount: number;
  /** Run-Records aller gefeuerten Routinen (success + failure). */
  runs: RunResult[];
  /** Fehler pro Routine (routineId → message). */
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
 * Schreibt last_run_at + next_run_at.  `now` = Fire-Zeitpunkt; next wird aus
 * der Cron-Expression relativ zu now berechnet.  Non-fatal — Fehler werden
 * geloggt und geschluckt (ein DB-Write-Fehler darf den Sweep nicht killen).
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
 * Findet alle fälligen cron-Routinen (active=1, triggerMode='cron',
 * nextRunAt IS NOT NULL, nextRunAt <= now) und feuert sie unter N11-Budget-
 * Kontrolle.  Non-fatal, fire-and-forget-freundlich.
 *
 * @param now  Unix-Epoch in ms.  Default: Date.now().  Nur in Tests überschreiben.
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
    // DB-Fehler beim SELECT → nichts feuern, aber nicht crashen.
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
    // BLOCKER B (2) — In-Process-Running-Guard.
    // Schon ein laufender Fire derselben Routine? → skip (deferred).
    // Schützt gegen Re-Entrancy wenn ein zweiter Sweep parallel reinkommt
    // (instrumentation-Interval + heartbeat-tick).
    // ------------------------------------------------------------------
    if (inflightRoutineIds.has(routineId)) {
      result.deferredCount += 1;
      process.stderr.write(
        `[routine-scheduler] deferred id=${routineId} (already running — re-entrancy guard)\n`,
      );
      continue;
    }

    // ------------------------------------------------------------------
    // N11-Admission-Token: SYNCHRON, nicht-blockierend.
    // tryAcquireSlot gibt sofort null zurück wenn kein Budget frei ist —
    // kein Queuing, kein await, kein Hängen.
    // ------------------------------------------------------------------
    const slot = resourcePool.tryAcquireSlot({
      kind: "ollama-heavy",
      subagentId: `routine-scheduler:${routineId}`,
      priority: "background",
    });
    if (slot === null) {
      // Kein Slot frei — defer, nicht droppen.  next_run_at bleibt unverändert.
      result.deferredCount += 1;
      process.stderr.write(
        `[routine-scheduler] deferred id=${routineId} (no slot available)\n`,
      );
      continue;
    }

    // ------------------------------------------------------------------
    // Wir haben uns zum Feuern entschieden.  AB HIER:
    //  - Running-Guard markieren (im finally entfernen).
    //  - BLOCKER B (1): next_run_at OPTIMISTISCH vorrücken, BEVOR wir awaiten.
    //    Eine 240-s-Routine verlässt damit sofort die Due-Menge.
    // ------------------------------------------------------------------
    inflightRoutineIds.add(routineId);
    advanceSchedule(routineId, row.cronExpr, now);

    // ------------------------------------------------------------------
    // BLOCKER A — Admission-Token-Lebensdauer abhängig vom action_kind.
    // plan-dispatch: executePlan() self-gated PRO STEP gegen das N11-Budget.
    //   → Token JETZT freigeben (vor dem await), sonst Doppel-Slot/Deadlock.
    // shell: kein Self-Gating → Token über die Ausführung halten.
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
    // skipScheduleUpdate=true: wir haben das Advance schon (optimistisch) gemacht.
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
      // shell: Token erst hier freigeben (über die Ausführung gehalten).
      // plan-dispatch: bereits vor dem await freigegeben → releaseOnce no-op.
      releaseOnce();
      inflightRoutineIds.delete(routineId);
    }
  }

  process.stderr.write(
    `[routine-scheduler] done — fired=${result.firedCount} deferred=${result.deferredCount} failed=${result.failedCount}\n`,
  );

  return result;
}
