/**
 * Push Dedup + Rate-Limit — persistent via SQLite.
 *
 * Warum SQLite statt in-memory Map:
 *   - Vercel Lambda-Cold-Start würde in-memory-Counter verlieren → doppelte
 *     Pushes bei jedem Scale-Out.
 *   - SQLite ist ohnehin da (better-sqlite3). Overhead pro Check < 1ms.
 *
 * Tabellen (migration 0007_workflow_state.sql):
 *   - push_dedup:   dedup_key → expires_at (5-Min-TTL typisch)
 *   - push_counters: bucket → count (z.B. 'global:day:2026-04-24')
 *
 * TTL-Cleanup: lazy on-read — wir checken `expires_at < now()` bei jedem
 * Zugriff. Kein Cron nötig. Bei hoher Volumetrie ließe sich das mit einem
 * periodischen `DELETE WHERE expires_at < ?` verbessern; für 1-User-MVP
 * reicht lazy-check.
 */

import { getDb } from "../../db/client";
import { ulid } from "../ulid";

const DEDUP_WINDOW_MIN = 5;
export const DEDUP_WINDOW_MS = DEDUP_WINDOW_MIN * 60 * 1000;

/**
 * Global daily cap — überschritten, werden neue Pushes skipped.
 * Override via ENV `LAZYOS_MAX_PUSHES_PER_DAY` möglich (Tests setzen das
 * auf 9999 um die Regel zu umgehen).
 */
export function maxPushesPerDay(): number {
  const raw = process.env.LAZYOS_MAX_PUSHES_PER_DAY;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 20;
}

// ---------------------------------------------------------------------------
// Dedup check
// ---------------------------------------------------------------------------

export interface DedupResult {
  isDuplicate: boolean;
  /** Erste-Zeitstempel des existierenden Dedup-Eintrags (falls duplicate). */
  firstSeenAt?: number;
}

/**
 * Prüft ob ein Push mit diesem Key in den letzten `DEDUP_WINDOW_MS` schon
 * gesendet wurde. Wenn NEIN: registriert den Key atomar und gibt
 * `{isDuplicate: false}` zurück — der Caller darf den Push feuern.
 * Wenn JA: `{isDuplicate: true, firstSeenAt}`, Caller skipped.
 */
export function checkAndRegisterDedup(
  dedupKey: string,
  ruleId: string,
  now: number = Date.now(),
): DedupResult {
  const db = getDb();

  // Clean expired entries for this key first (lazy GC).
  db.$raw
    .prepare(`DELETE FROM push_dedup WHERE dedup_key = ? AND expires_at < ?`)
    .run(dedupKey, now);

  const existing = db.$raw
    .prepare(
      `SELECT created_at FROM push_dedup WHERE dedup_key = ? AND expires_at >= ?`,
    )
    .get(dedupKey, now) as { created_at: number } | undefined;

  if (existing) {
    return { isDuplicate: true, firstSeenAt: existing.created_at };
  }

  db.$raw
    .prepare(
      `INSERT OR REPLACE INTO push_dedup (dedup_key, rule_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(dedupKey, ruleId, now, now + DEDUP_WINDOW_MS);

  return { isDuplicate: false };
}

// ---------------------------------------------------------------------------
// Rate-Limit / Counters
// ---------------------------------------------------------------------------

/**
 * Day-bucket key in UTC (Max arbeitet DACH-Zeitzone, aber für Cap-Semantik
 * ist UTC ausreichend — 20/Tag ist grob genug, dass der Zonen-Shift keinen
 * Unterschied macht).
 */
function dayBucket(now: number): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `global:day:${y}-${m}-${day}`;
}

function windowBucket(
  ruleId: string,
  windowMs: number,
  now: number,
): string {
  const start = Math.floor(now / windowMs) * windowMs;
  return `rule:${ruleId}:win:${start}`;
}

/**
 * Global-Cap-Check: liefert `{allowed, count, max}`. Erhöht nicht automatisch
 * — Caller ruft `recordPush(ruleId)` nach erfolgreichem Send.
 */
export function checkGlobalCap(now: number = Date.now()): {
  allowed: boolean;
  count: number;
  max: number;
} {
  const db = getDb();
  const bucket = dayBucket(now);
  const max = maxPushesPerDay();

  // Clean expired rows (24h TTL)
  db.$raw
    .prepare(`DELETE FROM push_counters WHERE expires_at < ?`)
    .run(now);

  const row = db.$raw
    .prepare(`SELECT count FROM push_counters WHERE bucket = ?`)
    .get(bucket) as { count: number } | undefined;

  const count = row?.count ?? 0;
  return { allowed: count < max, count, max };
}

/**
 * Per-Rule Rate-Limit check. `windowMs` + `max` definieren das Fenster.
 * Returns whether the rule is allowed to fire (ohne selbst zu increment'en).
 */
export function checkRuleRateLimit(
  ruleId: string,
  windowMs: number,
  max: number,
  now: number = Date.now(),
): { allowed: boolean; count: number } {
  const db = getDb();
  const bucket = windowBucket(ruleId, windowMs, now);

  db.$raw
    .prepare(`DELETE FROM push_counters WHERE expires_at < ?`)
    .run(now);

  const row = db.$raw
    .prepare(`SELECT count FROM push_counters WHERE bucket = ?`)
    .get(bucket) as { count: number } | undefined;
  const count = row?.count ?? 0;
  return { allowed: count < max, count };
}

/**
 * Nach erfolgreichem Push-Send aufrufen: increment'et global-daily-counter
 * und — wenn angegeben — rule-window-counter.
 */
export function recordPush(
  ruleId: string,
  perRuleWindowMs?: number,
  now: number = Date.now(),
): void {
  const db = getDb();

  // Global daily counter
  const dayKey = dayBucket(now);
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  db.$raw
    .prepare(
      `INSERT INTO push_counters (bucket, count, expires_at)
       VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
    )
    .run(dayKey, midnight.getTime());

  // Per-rule window counter (optional)
  if (perRuleWindowMs) {
    const bucket = windowBucket(ruleId, perRuleWindowMs, now);
    const expiresAt = Math.floor(now / perRuleWindowMs) * perRuleWindowMs + perRuleWindowMs;
    db.$raw
      .prepare(
        `INSERT INTO push_counters (bucket, count, expires_at)
         VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
      )
      .run(bucket, expiresAt);
  }
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export type PushOutcome = "sent" | "dedup" | "cap" | "error" | "skipped";

export function recordAudit(params: {
  ruleId: string;
  eventId?: string;
  outcome: PushOutcome;
  detail?: string;
  now?: number;
}): void {
  const db = getDb();
  const now = params.now ?? Date.now();
  db.$raw
    .prepare(
      `INSERT INTO push_audit (id, created_at, rule_id, event_id, outcome, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ulid(now),
      now,
      params.ruleId,
      params.eventId ?? null,
      params.outcome,
      params.detail ?? null,
    );
}

/**
 * Test-Helper: löscht alle Dedup-/Counter-/Audit-Rows. NUR in Tests aufrufen.
 */
export function __resetPushStateForTests(): void {
  const db = getDb();
  db.$raw.exec(
    `DELETE FROM push_dedup; DELETE FROM push_counters; DELETE FROM push_audit;`,
  );
}
