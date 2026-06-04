/**
 * Sub-Plan 01c · Stuck-Workstream-Detector (Schicht 1 + 4).
 *
 * Findet Workstreams die laut DB `active` sind aber kein Event mehr
 * in den letzten N Minuten produziert haben. Cause meist: Service-
 * Restart während ein `await waitForSniperPause(...)` lief — der Process
 * stirbt, DB hängt im active-State.
 *
 * Markiert solche WS als `stuck`. UI (Sub-Plan 01b Banner +
 * Workstream-Detail) zeigt sie dann mit Resume-/Cancel-Action.
 *
 * Wird gerufen:
 *   - Beim lazyos-web-Boot (one-shot in db/client.ts post-init)
 *   - Periodisch alle 60 s (interval in agent-server.ts ODER lazyos-web)
 */

import { getDb } from '../../db/client';

export interface StuckCheckOptions {
  /** Threshold-Millisekunden: kein Event seit X ms = stuck. Default 5 min. */
  thresholdMs?: number;
  /** Dry-Run — markiert nicht, gibt nur Liste zurück. */
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
 * Scannt active-Workstreams + markiert die hängenden als `stuck`.
 *
 * Idempotent. Mehrfach-Aufruf macht nichts Doppeltes.
 */
export function detectStuckWorkstreams(
  opts: StuckCheckOptions = {},
): StuckCheckResult {
  const thresholdMs = opts.thresholdMs ?? 5 * 60 * 1000;
  const dryRun = opts.dryRun === true;
  const now = Date.now();
  const cutoff = now - thresholdMs;

  const db = getDb();

  // Active-Workstreams mit primary_ticket_id (sonst können wir nicht
  // checken — kein Anchor für Events).
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
    // Letztes Event am primary-ticket
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
    // Push-Trigger: emit workstream-stuck-Event. Push-Rules
    // `workstream-stuck` (lib/push/rules.ts) feuert Notification.
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
 * Boot-Hook: wird einmalig bei lazyos-web Start gerufen. Findet alle
 * Workstreams die *jetzt* hängen müssten (>2 min seit letztem Event auf
 * einem Pause-Window — Pause sollte max 25 s sein, also 2 min ist sicher).
 */
export function runBootStuckCheck(): StuckCheckResult {
  // Beim Boot: aggressiver — 2 min reicht, weil ein Restart-Tod nur
  // wenige Sekunden vor Boot passiert. Ohne Aggressivität würden wir
  // 5 min lang einen toten Process für „lebt" halten.
  return detectStuckWorkstreams({ thresholdMs: 2 * 60 * 1000 });
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Periodischer Check — alle 60 s. Idempotent. Soll nur EINMAL pro
 * Process gerufen werden (sonst doppelte interval-Loops).
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
// Owner-Fix 2026-05-28 — Stuck-Aging / Maintenance-Helper.
//
// Begleitend zum Live-Filter in `/api/activity/live` (Workstreams im Status
// `stuck` mit updatedAt aelter als LAZYOS_STUCK_AGING_MS werden im Pill-
// Counter NICHT mehr gezeigt). Der Filter ist reversibel (kein DB-Mutate).
//
// Wenn der Owner alte stuck-Reste persistent als „abandoned" markieren will,
// ruft er diese Funktion explizit auf. Sie ist NICHT auto-gehookt — kein
// Boot-Side-Effect, kein Loop. Idempotent.
//
// Trade-off:
//   - Filter-only (Default in route.ts): keine DB-Aenderung, jederzeit
//     reversibel; aber stuck-Status bleibt in /lanes sichtbar.
//   - status='abandoned' (diese Funktion, opt-in): persistent + Push-fest;
//     irreversibel ohne Migration.
// ---------------------------------------------------------------------------

export interface MarkAbandonedOptions {
  /**
   * Aging-Schwellwert in Millisekunden. Stuck-WS mit updatedAt aelter als
   * `now - olderThanMs` werden markiert. Default 6h.
   */
  olderThanMs?: number;
  /** Dry-Run — nur Liste zurueck, kein Update. */
  dryRun?: boolean;
  /** Optionale Zeitreferenz fuer Tests (Default Date.now()). */
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
 * Markiert alte stuck-Workstreams als `abandoned` (Owner-Aufruf).
 *
 * Idempotent: einen bereits `abandoned`en WS faesst sie nicht nochmal an
 * (das `status='stuck'`-Filter im WHERE garantiert das). Mehrfach-Aufruf
 * ist deterministisch (N6) und fail-soft (kein Throw bei leerer Liste).
 *
 * Beispiel (Owner-Console):
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
