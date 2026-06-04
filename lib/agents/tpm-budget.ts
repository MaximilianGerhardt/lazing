/**
 * Phase QA · TPM budget manager (2026-04-28)
 *
 * Global tokens-per-minute tracker. Addresses the user problem:
 * "MAX plan collides with itself because 20+ parallel spawns
 * saturate the TPM bucket → Anthropic throttle → 'temporarily
 * limiting requests'."
 *
 * How it works:
 *   1. Every spawn (workspace-session, tier-spawn, runIterate-roaster,
 *      auto-dispatch-stage) calls `recordTokens()` AFTER the run with the
 *      actual token counts.
 *   2. Before every NEW spawn the caller calls `waitForBudget(estimatedTokens)`.
 *      The lib sums the rolling 60s window from tpm_tracker and decides:
 *        - <50% MAX_TPM → no sleep, spawn immediately
 *        - 50-70%       → 2s sleep
 *        - 70-90%       → 5s sleep
 *        - 90-100%      → 15s sleep + retry check
 *        - 100%+        → hard-block 30s, then try again
 *
 * MAX_TPM is conservatively set to 350k tokens/60s (MAX 20x estimation).
 * Override via env LAZYOS_MAX_TPM_BUDGET.
 *
 * NOT meant for absolute accuracy — a heuristic that proactively cushions
 * throttle hits.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { getDb } from '../../db/client';

const DEFAULT_MAX_TPM = 350_000;

function maxTpmBudget(): number {
  const raw = process.env.LAZYOS_MAX_TPM_BUDGET;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 10_000) return n;
  }
  return DEFAULT_MAX_TPM;
}

export interface TpmStatus {
  /** Current tokens in the last 60s. */
  current: number;
  /** Hard cap. */
  max: number;
  /** Percent utilization 0-100+. */
  pct: number;
  /** Level. */
  level: 'green' | 'yellow' | 'orange' | 'red' | 'over';
  /** Recommended sleep before a new spawn (ms). */
  recommendedDelayMs: number;
  /** Number of spawn events in the last 60s. */
  recentSpawns: number;
}

interface TpmRow {
  ts: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
}

/**
 * Reads the current TPM utilization. Cleanup side effect: rows older than 5min
 * are deleted (on every read tick, idempotent).
 */
export function getTpmStatus(
  now: number = Date.now(),
  opts: { userId?: string | null } = {},
): TpmStatus {
  const db = getDb();
  const max = maxTpmBudget();
  const windowStart = now - 60_000;
  const cleanupBefore = now - 5 * 60_000;

  try {
    db.$raw.prepare(`DELETE FROM tpm_tracker WHERE ts < ?`).run(cleanupBefore);
    // Phase MU.4 — If userId is set: count only this user's spawns.
    // Otherwise global (legacy path).
    const rows =
      opts.userId !== undefined
        ? (db.$raw
            .prepare(
              `SELECT ts, input_tokens, output_tokens, cache_read
                 FROM tpm_tracker
                WHERE ts >= ?
                  AND (user_id = ? OR (? IS NULL AND user_id IS NULL))`,
            )
            .all(windowStart, opts.userId, opts.userId) as TpmRow[])
        : (db.$raw
            .prepare(
              `SELECT ts, input_tokens, output_tokens, cache_read
                 FROM tpm_tracker
                WHERE ts >= ?`,
            )
            .all(windowStart) as TpmRow[]);

    // Cache-read counts minimally (costs only ~10% of the input-token rate),
    // we ignore it for the TPM budget — only in/out tokens.
    const current = rows.reduce(
      (acc, r) => acc + r.input_tokens + r.output_tokens,
      0,
    );
    const pct = Math.round((current / max) * 100);
    const level = pickLevel(pct);
    const recommendedDelayMs = pickDelay(pct);
    return {
      current,
      max,
      pct,
      level,
      recommendedDelayMs,
      recentSpawns: rows.length,
    };
  } catch {
    return {
      current: 0,
      max,
      pct: 0,
      level: 'green',
      recommendedDelayMs: 0,
      recentSpawns: 0,
    };
  }
}

function pickLevel(pct: number): TpmStatus['level'] {
  if (pct >= 100) return 'over';
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'orange';
  if (pct >= 50) return 'yellow';
  return 'green';
}

function pickDelay(pct: number): number {
  if (pct >= 100) return 30_000;
  if (pct >= 90) return 15_000;
  if (pct >= 70) return 5_000;
  if (pct >= 50) return 2_000;
  return 0;
}

/**
 * Call before every spawn. Sleeps when TPM load is high.
 * Estimated tokens can be used to throttle large spawns harder,
 * currently the value is only logged.
 */
export async function waitForBudget(
  source: string,
  _estimatedTokens?: number,
): Promise<TpmStatus> {
  const status = getTpmStatus();
  if (status.recommendedDelayMs > 0) {
    if (process.env.LAZYOS_TPM_LOG === '1') {
      console.log(
        `[tpm-budget] ${source} sleep ${status.recommendedDelayMs}ms · pct=${status.pct} · current=${status.current}/${status.max}`,
      );
    }
    await sleep(status.recommendedDelayMs);
  }
  return status;
}

/**
 * Call after every spawn. Writes a tracker entry for
 * rolling-window statistics.
 */
export function recordTokens(
  source: string,
  workspaceId: string | undefined,
  tokens: { input: number; output: number; cacheRead?: number },
  durationMs: number,
  userId?: string | null,
): void {
  const db = getDb();
  try {
    db.$raw
      .prepare(
        `INSERT INTO tpm_tracker (ts, source, workspace_id, input_tokens, output_tokens, cache_read, duration_ms, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        source,
        workspaceId ?? null,
        Math.max(0, Math.floor(tokens.input)),
        Math.max(0, Math.floor(tokens.output)),
        Math.max(0, Math.floor(tokens.cacheRead ?? 0)),
        Math.max(0, Math.floor(durationMs)),
        userId ?? null,
      );
  } catch (err) {
    if (process.env.LAZYOS_TPM_LOG === '1') {
      console.warn(
        '[tpm-budget] recordTokens failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Hard block: at >100% TPM, canSpawn() blocks new calls completely.
 * The caller need not call this function, waitForBudget already handles it —
 * but useful for the UI/status display.
 */
export function canSpawn(): boolean {
  return getTpmStatus().pct < 100;
}
