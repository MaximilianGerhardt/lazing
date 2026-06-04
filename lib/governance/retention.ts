/**
 * G5 — Retention-Policy (Phase 2 W2.1 · Lane G Governance · 2026-05-29).
 *
 * Integration plan §4 Lane G (verbatim, N1):
 *   „Retention Policy · Raw vs Derived Data Policy"
 *
 * Lane G establishes:
 *   - Raw data (e.g. an original whatsapp message) gets a short
 *     retention window (default 30 days).
 *   - Derived data (summary, embedding chunk, belief, …) gets
 *     a longer window (default 365 days).
 *   - Audit rows stay 7 years (GDPR Art. 30 record-keeping requirement).
 *   - A consent revoke has a grace period of 14 days (local
 *     pipeline latency) — after which still-persisted derivatives are likewise
 *     deleted or anonymized.
 *
 * These default values are workspace-overridable. The actual
 * garbage collection is NOT part of Lane G — it is the task of a
 * separate maintenance lane (Stage 3). Lane G only provides the policy
 * object + the deterministic `isExpired` check.
 *
 * Substrate discipline:
 *   - PURE module (no DB read, no LLM, no IO) — getWorkspaceRetention
 *     does have a DB-lookup trace, but is explicitly a DB-read helper
 *     (read-only) and fail-soft (workspace override missing → default).
 *   - N1: all fields verbatim.
 */

import type { ConsentLevel } from "./consent";

type RawDb = import("better-sqlite3").Database;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetentionPolicy {
  /** Days until raw data may be deleted. */
  readonly rawDataDays: number;
  /** Days until derived data may be deleted. */
  readonly derivedDataDays: number;
  /** Days until audit rows may be removed (GDPR Art. 30 = 7 years). */
  readonly auditRetentionDays: number;
  /** Grace period (days) after a consent revoke. */
  readonly consentRevocationGracePeriodDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rawDataDays: 30,
  derivedDataDays: 365,
  auditRetentionDays: 2555, // ≈ 7 years (GDPR Art. 30)
  consentRevocationGracePeriodDays: 14,
};

// ---------------------------------------------------------------------------
// isExpired — pure function
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Checks whether an item is considered expired after `days` days from `createdAt`.
 * Pure function — `nowMs` is optional and defaults to Date.now() (deterministically
 * overridable for tests).
 */
export function isExpired(
  createdAt: number,
  days: number,
  nowMs?: number,
): boolean {
  if (!Number.isFinite(createdAt) || !Number.isFinite(days) || days <= 0) {
    return false;
  }
  const now = nowMs ?? Date.now();
  return now - createdAt > days * MS_PER_DAY;
}

/**
 * Computes the expiry date (ms-epoch) for an item — pure function.
 */
export function retentionExpiresAt(createdAt: number, days: number): number {
  if (!Number.isFinite(createdAt) || !Number.isFinite(days) || days <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return createdAt + days * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Per-Workspace-Override (optional)
// ---------------------------------------------------------------------------

/**
 * Loads the effective RetentionPolicy for a workspace.
 *
 * Mechanics (additive, fail-soft):
 *   - Reads user_preferences (Migration 0114) for an optional override
 *     column. Since user_preferences is user-scoped in this codebase (not
 *     workspace-scoped), there is currently NO workspace override source —
 *     this function continuously returns DEFAULT_RETENTION_POLICY. A
 *     future `workspace_retention_overrides` table can be wired in here
 *     additively, without changing Lane G (purely a reader layer).
 *
 *   - workspaceId is validated, but is DB-readonly: no errors,
 *     fail-soft default return on any problem.
 */
export function getWorkspaceRetention(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- additively reserved for a future override read path
  raw: RawDb,
  workspaceId: string,
): RetentionPolicy {
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return DEFAULT_RETENTION_POLICY;
  }
  // Today: no workspace_retention_overrides table → return the default.
  // Hook for a later override lookup (additive, without a Lane-G change):
  //   const row = raw.prepare(
  //     `SELECT raw_days, derived_days, audit_days, grace_days
  //        FROM workspace_retention_overrides WHERE workspace_id = ?`,
  //   ).get(workspaceId) as Record<string, number> | undefined;
  //   if (row) return { rawDataDays: row.raw_days, ... };
  return DEFAULT_RETENTION_POLICY;
}

// ---------------------------------------------------------------------------
// Helpers for other Lane-G modules
// ---------------------------------------------------------------------------

/**
 * Returns the default retention (days) appropriate for a ConsentLevel.
 * `none` and `read-only` have raw retention; everything from `read-derive`
 * onward may be stored longer (derived).
 */
export function retentionDaysForLevel(
  level: ConsentLevel,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): number {
  switch (level) {
    case "none":
    case "read-only":
      return policy.rawDataDays;
    case "read-derive":
    case "read-derive-act":
    case "full-automation":
      return policy.derivedDataDays;
    default:
      // Fail-closed: unknown level → keep minimal.
      return policy.rawDataDays;
  }
}
