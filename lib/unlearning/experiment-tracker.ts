/**
 * Experiment-Tracker — Echter Pattern 9 "Unlearning" (2026-05-01).
 *
 * Kontext:
 *   Anne (Legaly-AI-Transkript): "to unlearn... immer wieder zu vergessen,
 *   was man eigentlich gerade dachte, zu wissen und sich neu drauf
 *   einzulassen... selbst wenn jetzt z.B. ein Prozessschritt noch nicht
 *   funktioniert oder ein Ergebnis noch nicht so ist, wie ich es mir
 *   vorgestellt habe, nicht zu sagen, ah, das funktioniert einfach nicht
 *   für diese Art des Anwendungsfalls oder die Qualität ist nicht gut
 *   genug, sondern es nächste Woche wieder zu probieren und einfach sehr
 *   viel zu experimentieren."
 *
 * Diese Datei ist der Speicher dafür: failedExperiments-DB-Tabelle, in die
 * Sub-Spawn-Failures, manuell markierte Versuche und Quality-Notes
 * geschrieben werden. Der Weekly-Retry-Sniper (scripts/weekly-retry-
 * sniper.ts) lädt unresolved Experiments und probiert sie neu.
 *
 * Fail-soft: alle Writes try/catch → niemals den Caller blocken (analog
 * `writeReasoningAudit` aus lib/audit/reasoning.ts).
 *
 * Zwei wichtige Vorgaben aus der Spec:
 *  1. KEIN Auto-Apply der Resolutions ohne User-Klick — der Sniper
 *     erzeugt Sub-Tickets statt Code direkt zu ändern.
 *  2. Hypotheses werden NICHT gehasht — Kollisionen sind erlaubt
 *     (mehrere Experimente mit identischer Hypothesis können parallel
 *     laufen).
 */

import { and, eq, isNull, lte, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  failedExperiments,
  type FailedExperimentInsert,
  type FailedExperimentRow,
} from "@/db/schema/failed_experiments";
import { ulid } from "@/lib/ulid";

const HYPOTHESIS_MAX = 500;
const TRUNC_MARK = "[truncated]";

export interface RecordFailedExperimentInput {
  workspaceId?: string | null;
  /** Was wurde versucht (max 500 Zeichen, längere werden mit `[truncated]` gekürzt). */
  hypothesis: string;
  /** Warum es fehlgeschlagen ist (Free-Text, Quality-Note, Error-Excerpt). */
  failureReason?: string;
  /** Modell-ID zum Zeitpunkt des Originalversuchs (z.B. claude-opus-4-7). */
  modelUsed?: string;
  workstreamId?: string | null;
  ticketId?: string | null;
}

/**
 * Schreibt ein Failed-Experiment. Returns die neue ID oder `null` bei Fehler.
 * Niemals throws — fail-soft.
 */
export function recordFailedExperiment(
  input: RecordFailedExperimentInput,
): string | null {
  try {
    const db = getDb();
    const id = `fxp_${ulid()}`;
    const hypothesis = truncateHypothesis(input.hypothesis);

    const insert: FailedExperimentInsert = {
      id,
      workspaceId: input.workspaceId ?? null,
      hypothesis,
      failureReason: input.failureReason ?? null,
      attemptedAt: Date.now(),
      modelUsed: input.modelUsed ?? null,
      retryCount: 0,
      lastRetryAt: null,
      resolvedAt: null,
      resolutionNote: null,
      workstreamId: input.workstreamId ?? null,
      ticketId: input.ticketId ?? null,
    };

    db.insert(failedExperiments).values(insert).run();
    return id;
  } catch (err) {
    console.warn(
      "[experiment-tracker] recordFailedExperiment failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Lädt alle unresolved Experiments älter als `maxAgeDays`.
 * Sortiert: ältestes zuerst (FIFO — älteste Frust zuerst auflösen).
 */
export function loadUnresolvedExperiments(
  maxAgeDays: number,
): FailedExperimentRow[] {
  try {
    const db = getDb();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    return db
      .select()
      .from(failedExperiments)
      .where(
        and(
          isNull(failedExperiments.resolvedAt),
          lte(failedExperiments.attemptedAt, cutoff),
        ),
      )
      .orderBy(failedExperiments.attemptedAt)
      .all();
  } catch (err) {
    console.warn(
      "[experiment-tracker] loadUnresolvedExperiments failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * Markiert ein Experiment als aufgelöst.
 *
 * Idempotent: zweiter Call mit demselben id ueberschreibt resolution_note +
 * resolved_at. Das ist gewollt — wenn ein Sniper-Run das Experiment löst und
 * der User später eine bessere Resolution hinzufügt, wins die letztere.
 */
export function markResolved(id: string, note: string): void {
  try {
    const db = getDb();
    db.update(failedExperiments)
      .set({ resolvedAt: Date.now(), resolutionNote: note })
      .where(eq(failedExperiments.id, id))
      .run();
  } catch (err) {
    console.warn(
      "[experiment-tracker] markResolved failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Zählt retry_count um eins hoch und setzt last_retry_at = now.
 * Wird vom Weekly-Retry-Sniper bei jedem Re-Try aufgerufen.
 */
export function incrementRetryCount(id: string): void {
  try {
    const db = getDb();
    db.update(failedExperiments)
      .set({
        retryCount: sql`${failedExperiments.retryCount} + 1`,
        lastRetryAt: Date.now(),
      })
      .where(eq(failedExperiments.id, id))
      .run();
  } catch (err) {
    console.warn(
      "[experiment-tracker] incrementRetryCount failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Truncate hypothesis auf MAX. Exportiert für Tests.
 *
 * Pattern: behalte den TRUNC_MARK *innerhalb* des Limits, damit das gespeicherte
 * Feld ≤ MAX bleibt (DB-Schema legt keine Length-Constraint, aber UI rendert
 * mit harten Cap).
 */
export function truncateHypothesis(s: string): string {
  if (s.length <= HYPOTHESIS_MAX) return s;
  const head = s.slice(0, HYPOTHESIS_MAX - TRUNC_MARK.length);
  return `${head}${TRUNC_MARK}`;
}

export type { FailedExperimentRow };
