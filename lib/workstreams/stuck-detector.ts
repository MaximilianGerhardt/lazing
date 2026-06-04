/**
 * Sub-plan 01c · stuck-workstream detector (layer 1 + 4).
 *
 * Finds workstreams that are `active` per the DB but produced no event
 * in the last N minutes. Cause usually: a service
 * restart while an `await waitForSniperPause(...)` was running — the process
 * dies, the DB hangs in the active state.
 *
 * Marks such WS as `stuck`. The UI (sub-plan 01b banner +
 * workstream detail) then shows them with a resume/cancel action.
 *
 * Called:
 *   - At lazyos-web boot (one-shot in db/client.ts post-init)
 *   - Periodically every 60 s (interval in agent-server.ts OR lazyos-web)
 */

import { getDb } from '../../db/client';

export interface StuckCheckOptions {
  /** Threshold milliseconds: no event for X ms = stuck. Default 5 min. */
  thresholdMs?: number;
  /** Dry run — does not mark, only returns the list. */
  dryRun?: boolean;
}

export interface StuckCheckResult {
  scanned: number;
  marked: string[];
  details: Array<{
    workstreamId: string;
    workspaceId: string;
    primaryTicketId: string | null;
    lastEventAt: number | null;
    msSinceLastEvent: number;
  }>;
}

/**
 * Scans active workstreams + marks the stuck ones as `stuck`.
 *
 * Idempotent. Repeated calls do nothing twice.
 */
export function detectStuckWorkstreams(
  opts: StuckCheckOptions = {},
): StuckCheckResult {
  const thresholdMs = opts.thresholdMs ?? 5 * 60 * 1000;
  const dryRun = opts.dryRun === true;
  const now = Date.now();
  const cutoff = now - thresholdMs;

  const db = getDb();

  // Active workstreams with a primary_ticket_id (otherwise we can't
  // check — no anchor for events).
  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, primary_ticket_id, updated_at
         FROM workstreams
        WHERE status = 'active'
          AND primary_ticket_id IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    primary_ticket_id: string;
    updated_at: number;
  }>;

  const stuckList: StuckCheckResult['details'] = [];

  for (const ws of rows) {
    // Last event on the primary ticket
    const evRow = db.$raw
      .prepare(
        `SELECT MAX(created_at) as last_at
           FROM events
          WHERE entity_type = 'ticket'
            AND entity_id = ?`,
      )
      .get(ws.primary_ticket_id) as { last_at: number | null } | undefined;
    const lastEventAt = evRow?.last_at ?? ws.updated_at;
    const msSince = now - lastEventAt;
    if (lastEventAt < cutoff) {
      stuckList.push({
        workstreamId: ws.id,
        workspaceId: ws.workspace_id,
        primaryTicketId: ws.primary_ticket_id,
        lastEventAt,
        msSinceLastEvent: msSince,
      });
    }
  }

  if (!dryRun && stuckList.length > 0) {
    const stmt = db.$raw.prepare(
      `UPDATE workstreams SET status = 'stuck', updated_at = ?
        WHERE id = ? AND status = 'active'`,
    );
    for (const s of stuckList) {
      stmt.run(now, s.workstreamId);
    }
    // Push trigger: emit a workstream-stuck event. The push rule
    // `workstream-stuck` (lib/push/rules.ts) fires the notification.
    void (async () => {
      try {
        const { emitEvent } = await import('../events/emit');
        for (const s of stuckList) {
          if (!s.primaryTicketId) continue;
          await emitEvent({
            segmentId: s.workspaceId,
            entityType: 'ticket',
            entityId: s.primaryTicketId,
            eventType: 'commented',
            actor: 'system',
            payload: {
              kind: 'workstream-stuck',
              workstreamId: s.workstreamId,
              minutesSinceLastEvent: Math.round(s.msSinceLastEvent / 60_000),
            },
            sensitivity: 'low',
          }).catch(() => undefined);
        }
      } catch {
        /* non-fatal */
      }
    })();
  }

  return {
    scanned: rows.length,
    marked: dryRun ? [] : stuckList.map((s) => s.workstreamId),
    details: stuckList,
  };
}

/**
 * Boot hook: called once at lazyos-web start. Finds all
 * workstreams that should *now* be stuck (>2 min since the last event on
 * a pause window — a pause should be max 25 s, so 2 min is safe).
 */
export function runBootStuckCheck(): StuckCheckResult {
  // At boot: more aggressive — 2 min is enough because a restart death happens only
  // a few seconds before boot. Without aggressiveness we would
  // hold a dead process as "alive" for 5 min.
  return detectStuckWorkstreams({ thresholdMs: 2 * 60 * 1000 });
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic check — every 60 s. Idempotent. Should be called only ONCE per
 * process (otherwise duplicate interval loops).
 */
export function startStuckDetectorLoop(intervalMs = 60_000): void {
  if (intervalHandle !== null) return;
  intervalHandle = setInterval(() => {
    try {
      detectStuckWorkstreams();
    } catch (err) {
      console.warn(
        '[stuck-detector] periodic scan failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }, intervalMs);
}

export function stopStuckDetectorLoop(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Owner fix 2026-05-28 — stuck aging / maintenance helper.
//
// Accompanying the live filter in `/api/activity/live` (workstreams in status
// `stuck` with updatedAt older than LAZYOS_STUCK_AGING_MS are NO longer shown in the pill
// counter). The filter is reversible (no DB mutation).
//
// When the owner wants to mark old stuck remnants persistently as "abandoned",
// they call this function explicitly. It is NOT auto-hooked — no
// boot side effect, no loop. Idempotent.
//
// Trade-off:
//   - Filter-only (default in route.ts): no DB change, reversible at any
//     time; but the stuck status stays visible in /lanes.
//   - status='abandoned' (this function, opt-in): persistent + push-proof;
//     irreversible without a migration.
// ---------------------------------------------------------------------------

export interface MarkAbandonedOptions {
  /**
   * Aging threshold in milliseconds. Stuck WS with updatedAt older than
   * `now - olderThanMs` are marked. Default 6h.
   */
  olderThanMs?: number;
  /** Dry run — returns only the list, no update. */
  dryRun?: boolean;
  /** Optional time reference for tests (default Date.now()). */
  now?: number;
}

export interface MarkAbandonedResult {
  scanned: number;
  marked: string[];
  details: Array<{
    workstreamId: string;
    workspaceId: string;
    previousStatus: 'stuck';
    msSinceUpdate: number;
  }>;
}

/**
 * Marks old stuck workstreams as `abandoned` (owner call).
 *
 * Idempotent: it does not touch an already-`abandoned` WS again
 * (the `status='stuck'` filter in the WHERE guarantees this). Repeated calls
 * are deterministic (N6) and fail-soft (no throw on an empty list).
 *
 * Example (owner console):
 *   import { markAbandonedStuckWorkstreams } from '@/lib/workstreams/stuck-detector';
 *   const res = markAbandonedStuckWorkstreams({ olderThanMs: 24 * 60 * 60 * 1000 });
 *   console.log('marked', res.marked);
 */
export function markAbandonedStuckWorkstreams(
  opts: MarkAbandonedOptions = {},
): MarkAbandonedResult {
  const olderThanMs = opts.olderThanMs ?? 6 * 60 * 60 * 1000;
  const dryRun = opts.dryRun === true;
  const now = opts.now ?? Date.now();
  const cutoff = now - olderThanMs;

  const db = getDb();

  const rows = db.$raw
    .prepare(
      `SELECT id, workspace_id, updated_at
         FROM workstreams
        WHERE status = 'stuck'
          AND updated_at < ?`,
    )
    .all(cutoff) as Array<{
    id: string;
    workspace_id: string;
    updated_at: number;
  }>;

  const details: MarkAbandonedResult['details'] = rows.map((r) => ({
    workstreamId: r.id,
    workspaceId: r.workspace_id,
    previousStatus: 'stuck' as const,
    msSinceUpdate: now - (r.updated_at ?? now),
  }));

  if (!dryRun && rows.length > 0) {
    const stmt = db.$raw.prepare(
      `UPDATE workstreams SET status = 'abandoned', updated_at = ?
        WHERE id = ? AND status = 'stuck'`,
    );
    for (const r of rows) {
      stmt.run(now, r.id);
    }
  }

  return {
    scanned: rows.length,
    marked: dryRun ? [] : rows.map((r) => r.id),
    details,
  };
}
