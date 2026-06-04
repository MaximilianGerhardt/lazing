/**
 * Experiment tracker — true pattern 9 "Unlearning" (2026-05-01).
 *
 * Context:
 *   Anne (Legaly-AI transcript): "to unlearn... immer wieder zu vergessen,
 *   was man eigentlich gerade dachte, zu wissen und sich neu drauf
 *   einzulassen... selbst wenn jetzt z.B. ein Prozessschritt noch nicht
 *   funktioniert oder ein Ergebnis noch nicht so ist, wie ich es mir
 *   vorgestellt habe, nicht zu sagen, ah, das funktioniert einfach nicht
 *   für diese Art des Anwendungsfalls oder die Qualität ist nicht gut
 *   genug, sondern es nächste Woche wieder zu probieren und einfach sehr
 *   viel zu experimentieren."
 *
 * This file is the store for it: the failedExperiments DB table, into which
 * sub-spawn failures, manually flagged attempts, and quality notes are
 * written. The weekly-retry sniper (scripts/weekly-retry-
 * sniper.ts) loads unresolved experiments and retries them.
 *
 * Fail-soft: all writes try/catch → never block the caller (analogous to
 * `writeReasoningAudit` from lib/audit/reasoning.ts).
 *
 * Two important requirements from the spec:
 *  1. NO auto-apply of resolutions without a user click — the sniper
 *     creates sub-tickets instead of changing code directly.
 *  2. Hypotheses are NOT hashed — collisions are allowed
 *     (multiple experiments with an identical hypothesis can run
 *     in parallel).
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
  /** What was attempted (max 500 chars; longer ones are truncated with `[truncated]`). */
  hypothesis: string;
  /** Why it failed (free text, quality note, error excerpt). */
  failureReason?: string;
  /** Model ID at the time of the original attempt (e.g. claude-opus-4-7). */
  modelUsed?: string;
  workstreamId?: string | null;
  ticketId?: string | null;
}

/**
 * Writes a failed experiment. Returns the new ID or `null` on error.
 * Never throws — fail-soft.
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
 * Loads all unresolved experiments older than `maxAgeDays`.
 * Sorted: oldest first (FIFO — resolve the oldest frustration first).
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
 * Marks an experiment as resolved.
 *
 * Idempotent: a second call with the same id overwrites resolution_note +
 * resolved_at. This is intentional — if a sniper run resolves the experiment
 * and the user later adds a better resolution, the latter wins.
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
 * Increments retry_count by one and sets last_retry_at = now.
 * Called by the weekly-retry sniper on every retry.
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
 * Truncate hypothesis to MAX. Exported for tests.
 *
 * Pattern: keep the TRUNC_MARK *within* the limit so the stored
 * field stays ≤ MAX (the DB schema sets no length constraint, but the UI
 * renders with a hard cap).
 */
export function truncateHypothesis(s: string): string {
  if (s.length <= HYPOTHESIS_MAX) return s;
  const head = s.slice(0, HYPOTHESIS_MAX - TRUNC_MARK.length);
  return `${head}${TRUNC_MARK}`;
}

export type { FailedExperimentRow };
