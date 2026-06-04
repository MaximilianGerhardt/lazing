/**
 * Self-healing workstream recovery sweep (2026-05-25).
 *
 * Problem: after a service restart (or an agent crash),
 * workstreams stay stuck forever in `active` or `paused` — the in-memory
 * inFlight state of the agent server is gone, yet the DB row still says
 * "running". The user sees nothing happen for 2.5 hours.
 *
 * Fix: `sweepStaleWorkstreams` runs periodically (every 3 min) and
 * conservatively terminalizes orphaned runs to `stuck`:
 *
 *   1. SELECT active/paused WHERE updated_at < now - STALE_MS.
 *   2. Per run (isolated, try/catch): → status='stuck', decision row
 *      (N8, decisionKind='orphan_detected'), status card, push notification
 *      (kind='run-stuck' via the answer_required mechanic).
 *   3. Idempotent: already-stuck rows are not touched again.
 *   4. Bounded: max MAX_PER_TICK runs per sweep pass.
 *   5. In-process guard against a double sweep.
 *
 * NEVER blindly re-spawn (no auto-exec). Honestly stuck + notify is the
 * solution. The user gets a notification + deep link to restart themselves via
 * /api/workstreams/[id]/resume.
 *
 * Process locality: runs in the Next.js process via instrumentation.ts —
 * DB + broadcast + emitOrUpdateCard are available here.
 *
 * Operating constraints (N6/N8/N10):
 *   N6:  Deterministic time proxy (updated_at) instead of LLM reasoning.
 *   N8:  Every terminalization writes a workstream_decisions row.
 *   N10: content_hash in the decision row (internally via writeDecision).
 */

import { getDb } from '@/db/client';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { emitAnswerRequired } from '@/lib/push/triggers';

/**
 * Builds the same-origin resume deep link. The URL belongs EXCLUSIVELY in the
 * `href` of a markdown link — never in the visible card text (Apple-feed
 * cleanliness, 2026-05-30). No secret (only workspace + workstream ID).
 */
function resumeHref(workspaceId: string, workstreamId: string): string {
  return `/?workspace=${encodeURIComponent(workspaceId)}&ws=${encodeURIComponent(
    workstreamId,
  )}&action=resume`;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Threshold milliseconds: active/paused without updated_at progress = orphaned.
 * Default 20 min. Overridable via ENV `LAZYOS_WS_STALE_MS`.
 *
 * Choice (critic fix #1a, 2026-05-25): 12 min was TOO TIGHT. A normal iterate
 * wave (Opus lead 4-5min + roaster 3min + sniper pause + V2 lead 4min ≈ 11min)
 * does NOT bump the MASTER `updated_at` during the sub-spawns — only the sub-WS
 * rows are bumped. So a live master looked "stale" after 12 min.
 *
 * 20 min sits safely above a full wave. Additionally the
 * liveness guard (sub-WS activity) in terminateOrphanedRun kicks in — that is the
 * actual safeguard against false terminalization, the threshold is only the
 * coarse pre-selection.
 */
export const STALE_MS: number = (() => {
  const raw = process.env.LAZYOS_WS_STALE_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 20 * 60_000; // 20 min
})();

/**
 * Liveness window (critic fix #1b): a master counts as ALIVE when it
 * has at least one active sub-workstream whose `updated_at` is younger than
 * this window. Sub-spawns (lead/roaster/synthesis) bump their own
 * row via updateTokenUsage/setSubWorkstreamStatus — as long as one of them is recent,
 * the wave is still running. 3 min covers the longest single phase (Opus lead)
 * with reserve.
 */
export const SUB_ACTIVITY_WINDOW_MS = 3 * 60_000;

/**
 * Maximum number of runs terminalized per sweep tick.
 * Protection against "first boot after long downtime = 200 stuck rows at once".
 */
export const MAX_PER_TICK = 25;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface RecoverySweepResult {
  /** Number of runs the query returned as potentially stale. */
  scanned: number;
  /** IDs of runs successfully set to stuck. */
  terminated: string[];
  /** Runs that threw an error during terminalization (the sweep continues). */
  errors: number;
  /** Timestamp (ms) of the sweep start. */
  sweptAt: number;
  /** true when another sweep was still running (→ this pass was aborted). */
  skippedDueToConcurrentSweep: boolean;
}

// ---------------------------------------------------------------------------
// In-process concurrency guard
// ---------------------------------------------------------------------------

let sweepInProgress = false;

// ---------------------------------------------------------------------------
// Main sweep function
// ---------------------------------------------------------------------------

/**
 * Scans active/paused workstreams that had no updated_at
 * update for longer than STALE_MS and marks them as `stuck` (orphan_detected decision +
 * status card + push notification).
 *
 * @param now  Current timestamp proxy. Default: Date.now(). Makes it testable.
 */
export async function sweepStaleWorkstreams(
  now: number = Date.now(),
): Promise<RecoverySweepResult> {
  const sweptAt = now;

  // In-process guard: prevents a double sweep with a fast interval +
  // long DB latency. Returns a skipped result instead of blocking.
  if (sweepInProgress) {
    return {
      scanned: 0,
      terminated: [],
      errors: 0,
      sweptAt,
      skippedDueToConcurrentSweep: true,
    };
  }

  sweepInProgress = true;
  try {
    return await runSweep(now, sweptAt);
  } finally {
    sweepInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

interface StaleWorkstreamRow {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  updated_at: number;
}

async function runSweep(now: number, sweptAt: number): Promise<RecoverySweepResult> {
  const db = getDb();
  const cutoff = now - STALE_MS;

  // SELECT: active or paused, no recent updated_at.
  // Bounded: LIMIT MAX_PER_TICK prevents a storm on the first boot after
  // long downtime (many stuck rows).
  // Already-stuck rows explicitly excluded — idempotency.
  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, name, status, updated_at
         FROM workstreams
        WHERE status IN ('active', 'paused')
          AND updated_at < ?
        ORDER BY updated_at ASC
        LIMIT ?`,
    )
    .all(cutoff, MAX_PER_TICK) as StaleWorkstreamRow[];

  const scanned = rows.length;
  const terminated: string[] = [];
  let errors = 0;

  for (const row of rows) {
    try {
      const didTerminate = await terminateOrphanedRun(row, now);
      if (didTerminate) terminated.push(row.id);
    } catch (err) {
      // Isolated error: a broken row does NOT abort the sweep.
      errors += 1;
      console.warn(
        '[recovery] sweepStaleWorkstreams: Fehler beim Terminalisieren von',
        row.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (terminated.length > 0) {
    console.info(
      `[recovery] Sweep: ${terminated.length} orphaned Workstream(s) auf stuck gesetzt`,
      `(scanned=${scanned}, errors=${errors}, stale>${Math.round(STALE_MS / 60_000)}min)`,
    );
  }

  // Reliability sweep 2026-05-30: piggyback the orphaned-flow_runs reaper on
  // the already-wired recovery interval (3 min, instrumentation.ts:111).
  // flow_runs collects pending/running rows that never terminalize when the
  // associated workstream is missing or already terminal (DB finding: 39
  // stuck rows). The reaper is fail-soft + idempotent + status-guarded
  // (NEVER catches a flow run whose workstream is still active/paused), so it's
  // safe to run along here without its own wiring. Non-fatal: an error in the
  // flow_run reap must not topple the workstream sweep report.
  try {
    const { reapOrphanedFlowRuns } = await import('@/lib/workstreams/reap-stale');
    reapOrphanedFlowRuns({ now });
  } catch (err) {
    console.warn(
      '[recovery] reapOrphanedFlowRuns (piggyback) fehlgeschlagen (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  return { scanned, terminated, errors, sweptAt, skippedDueToConcurrentSweep: false };
}

/**
 * Terminalizes a single orphaned run.
 *
 * Returns `true` when the run was actually terminalized,
 * `false` when it is alive OR a concurrent update prevented the race
 * (neither is an error).
 *
 *   0. Liveness guard (critic fix #1b): if the master has an active sub-WS
 *      with recent updated_at → the wave is still running → return false (no stuck).
 *   1. Atomic: UPDATE status='stuck' ONLY when status is still active/paused
 *      (prevents a race with a concurrent sweep or a real agent finish).
 *   2. N8: writeDecision (orphan_detected) — best-effort, non-fatal.
 *   3. Status card via emitOrUpdateCard — shows the "restart?" prompt.
 *   4. Push notification via emitAnswerRequired (kind='run-stuck').
 *
 * Push fires ONLY on the active/paused→stuck transition (changes>0). An already
 * statically-stuck run is not captured by the SELECT at all (status IN active/paused)
 * → no re-push (critic verification #2).
 */
async function terminateOrphanedRun(
  row: StaleWorkstreamRow,
  now: number,
): Promise<boolean> {
  const db = getDb();
  const staleMinutes = Math.round((now - row.updated_at) / 60_000);
  const prevStatus = row.status;

  // 0. Liveness guard: check whether the master has active sub-workstreams with recent
  //    activity. During the sub-spawns, an iterate wave bumps only the
  //    sub-WS rows (lead/roaster/synthesis) — the master row stays static.
  //    A hit → the run is alive → do NOT terminalize (no stuck/push/decision).
  const subActivityCutoff = now - SUB_ACTIVITY_WINDOW_MS;
  const liveSub = db.$raw
    .prepare(
      `SELECT 1
         FROM workstreams
        WHERE parent_workstream_id = ?
          AND status = 'active'
          AND updated_at > ?
        LIMIT 1`,
    )
    .get(row.id, subActivityCutoff) as { 1: number } | undefined;

  if (liveSub) {
    // Live wave — the master updated_at is only old because the
    // sub-spawns bump their own row, not the master row.
    return false;
  }

  // 1. Atomically set to stuck — WHERE guard against a race.
  //    If no row is updated (Result.changes === 0): a concurrent
  //    sweep or a real agent already changed the state → skip.
  const result = db.$raw
    .prepare(
      `UPDATE workstreams
          SET status = 'stuck', updated_at = ?
        WHERE id = ? AND status IN ('active', 'paused')`,
    )
    .run(now, row.id);

  if ((result as { changes?: number }).changes === 0) {
    // Race condition: the row was changed between SELECT and UPDATE.
    // No error, no further step needed.
    return false;
  }

  const rationale =
    `Recovery-Sweep: ${staleMinutes}min ohne updated_at-Fortschritt, ` +
    `Status war '${prevStatus}'. Reason: orphaned-no-progress:${staleMinutes}min. ` +
    `Agent-Server-inFlight ist in-memory — Zeit-Proxy (updated_at) korrekt.`;

  // 2. N8: write the decision row (best-effort).
  writeDecision({
    workspaceId: row.workspace_id,
    workstreamId: row.id,
    coordKey: `${row.workspace_id}/${row.id}`,
    decisionKind: 'orphan_detected',
    rationale,
    actor: 'policy',
  });

  // 3. Status card: visible in chat + workstream detail.
  //    Apple-feed cleanliness (2026-05-30): NO raw URL/IDs in the visible text.
  //    The clean sentence carries only the run name; the resume URL lives
  //    exclusively in the `href` of the markdown link (label „Neu starten") — the
  //    markdown-mini renderer renders same-origin links as a clean pill and
  //    shows ONLY the label, never the query. No secret in the content (N8/privacy).
  const cardContent =
    `Ein Lauf wurde durch einen Neustart pausiert. ` +
    `[Neu starten](${resumeHref(row.workspace_id, row.id)})`;

  try {
    await emitOrUpdateCard({
      coords: {
        workspaceId: row.workspace_id,
        workstreamId: row.id,
        // 'toast' = system notification card. 'status' is not a registered
        // SurfaceKind — we use 'toast' for the recovery message.
        surfaceKind: 'toast',
      },
      content: cardContent,
      actor: 'system',
    });
  } catch (cardErr) {
    // Non-fatal: if the card can't be emitted, the stuck
    // status is set anyway. The push follows independently.
    console.warn(
      '[recovery] emitOrUpdateCard fehlgeschlagen (non-fatal):',
      row.id,
      cardErr instanceof Error ? cardErr.message : String(cardErr),
    );
  }

  // 4. Push notification via answer_required / emitAnswerRequired.
  //    The visibility gate kicks in internally (no push when the tab is visible).
  //    kind='run-stuck' is caught by the new PUSH_RULES rule.
  emitAnswerRequired({
    workspaceId: row.workspace_id,
    entityId: row.id,
    kind: 'run-stuck',
    preview: `"${row.name.slice(0, 60)}" seit ${staleMinutes}min ohne Fortschritt — gestoppt`,
    url: `/?workspace=${encodeURIComponent(row.workspace_id)}&ws=${encodeURIComponent(row.id)}&action=resume`,
  });

  return true;
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Resets the in-process sweep guard. Use ONLY in tests.
 */
export function __resetSweepGuardForTests(): void {
  sweepInProgress = false;
}
