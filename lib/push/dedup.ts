/**
 * Push Dedup + Rate-Limit — persistent via SQLite.
 *
 * Why SQLite instead of an in-memory Map:
 *   - A Vercel Lambda cold-start would lose the in-memory counter → duplicate
 *     pushes on every scale-out.
 *   - SQLite is here anyway (better-sqlite3). Overhead per check < 1ms.
 *
 * Tables (migration 0007_workflow_state.sql):
 *   - push_dedup:   dedup_key → expires_at (5-min TTL typical)
 *   - push_counters: bucket → count (e.g. 'global:day:2026-04-24')
 *
 * TTL cleanup: lazy on-read — we check `expires_at < now()` on every
 * access. No cron needed. At high volume this could be improved with a
 * periodic `DELETE WHERE expires_at < ?`; for the 1-user MVP a
 * lazy check is enough.
 */

import { getDb } from "../../db/client";
import { ulid } from "../ulid";

const DEDUP_WINDOW_MIN = 5;
export const DEDUP_WINDOW_MS = DEDUP_WINDOW_MIN * 60 * 1000;

/**
 * Global daily cap — once exceeded, new pushes are skipped.
 * Override via ENV `LAZYOS_MAX_PUSHES_PER_DAY` possible (tests set it
 * to 9999 to bypass the rule).
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
  /** First-seen timestamp of the existing dedup entry (if duplicate). */
  firstSeenAt?: number;
}

/**
 * Checks whether a push with this key was already sent within the last
 * `DEDUP_WINDOW_MS`. If NO: registers the key atomically and returns
 * `{isDuplicate: false}` — the caller may fire the push.
 * If YES: `{isDuplicate: true, firstSeenAt}`, caller skips.
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
 * Day-bucket key in UTC (the operator works in the DACH timezone, but for
 * cap semantics UTC is sufficient — 20/day is coarse enough that the zone
 * shift makes no difference).
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
 * Global-cap check: returns `{allowed, count, max}`. Does NOT increment
 * automatically — the caller invokes `recordPush(ruleId)` after a successful send.
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
 * Per-rule rate-limit check. `windowMs` + `max` define the window.
 * Returns whether the rule is allowed to fire (without incrementing itself).
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
 * Call after a successful push send: increments the global-daily counter
 * and — if given — the rule-window counter.
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
 * Test helper: deletes all dedup/counter/audit rows. Call ONLY in tests.
 */
export function __resetPushStateForTests(): void {
  const db = getDb();
  db.$raw.exec(
    `DELETE FROM push_dedup; DELETE FROM push_counters; DELETE FROM push_audit;`,
  );
}
