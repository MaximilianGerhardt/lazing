// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// W1.H2 — lib/audit/verify.ts — ContentHash-Verify-Runner for 8 M9 audit
// tables + M6 priority-audit. Re-hashes sampled rows and compares to the
// stored `content_hash`. Pre-step: trigger/view existence check.
//
// Authority: modules/W1/W1.H2/audit-verify-MODUL-SPEC.md

import type Database from 'better-sqlite3';
import type { AuditTable } from './insert';
import { computeContentHash } from './canonical-json';

export type SampleMode = 'adaptive' | 'full' | number;

export interface VerifyOptions {
  sampleSize?: number;
  sampling?: 'adaptive' | 'recent' | 'all';
  skipFreshMarkers?: boolean;
  triggerExistenceCheck?: boolean;
}

export interface VerifyMismatch {
  id: number | string;
  reason:
    | 'hash-mismatch'
    | 'fresh-marker-mismatch'
    | 'trigger-existence-missing'
    | 'view-existence-missing'
    | 'trigger-body-tampered'
    | 'row-deleted-but-marker-active';
  expected?: string;
  actual?: string;
  details?: string;
}

export interface VerifyResult {
  totalChecked: number;
  mismatches: VerifyMismatch[];
  sampleSize: number;
  tableSize: number;
  durationMs: number;
  triggerExistenceOk: boolean;
  triggerExistenceMissing: string[];
}

const EXPECTED_TRIGGERS_PER_TABLE = ['no_update', 'no_delete', 'hash_format'];
const EXPECTED_TRIGGER_TABLES: AuditTable[] = [
  'lazyos_tool_audit',
  'lazyos_bridge_audit',
  'lazyos_spawn_audit',
  'lazyos_spawn_completion',
  'lazyos_audit_verify_log',
  'lazyos_mcp_filter_audit',
  'lazyos_security_override_audit',
  'lazyos_lint_override_audit',
];
const EXPECTED_VIEW_NAME = 'lazyos_security_override_active';

/**
 * Trigger-Existence-Check (M9 BUG-FIX-1 Block-4 Mitigation 2).
 * Detects DROP TRIGGER + DROP VIEW bypass vectors (writable_schema attacks).
 */
export function verifyTriggerExistence(db: Database.Database): {
  ok: boolean;
  missing: string[];
  foundTriggers: number;
  foundViews: number;
} {
  const rows = db
    .prepare(
      `SELECT name, type FROM sqlite_master
        WHERE name LIKE 'lazyos_%_no_update'
           OR name LIKE 'lazyos_%_no_delete'
           OR name LIKE 'lazyos_%_hash_format'
           OR name = ?`,
    )
    .all(EXPECTED_VIEW_NAME) as Array<{ name: string; type: string }>;

  const triggerNames = new Set(
    rows.filter((r) => r.type === 'trigger').map((r) => r.name),
  );
  const viewNames = new Set(
    rows.filter((r) => r.type === 'view').map((r) => r.name),
  );

  const missing: string[] = [];
  for (const t of EXPECTED_TRIGGER_TABLES) {
    for (const kind of EXPECTED_TRIGGERS_PER_TABLE) {
      const expected = `${t}_${kind}`;
      if (!triggerNames.has(expected)) missing.push(`trigger:${expected}`);
    }
  }
  if (!viewNames.has(EXPECTED_VIEW_NAME)) {
    missing.push(`view:${EXPECTED_VIEW_NAME}`);
  }
  return {
    ok: missing.length === 0,
    missing,
    foundTriggers: triggerNames.size,
    foundViews: viewNames.size,
  };
}

/** Adaptive sample-size (CRON-VERIFY-SPEC §2.1). */
export function computeAdaptiveSampleSize(tableSize: number): {
  sampleSize: number;
  recentMin: number;
} {
  if (tableSize < 1_000) return { sampleSize: tableSize, recentMin: tableSize };
  if (tableSize < 100_000) {
    const s = Math.max(100, Math.ceil(tableSize * 0.01));
    return { sampleSize: s, recentMin: Math.max(10, Math.ceil(s * 0.3)) };
  }
  if (tableSize < 1_000_000) {
    const s = Math.max(1_000, Math.ceil(tableSize * 0.001));
    return { sampleSize: s, recentMin: Math.max(10, Math.ceil(s * 0.3)) };
  }
  const s = Math.max(10_000, Math.ceil(tableSize * 0.0001));
  return { sampleSize: s, recentMin: Math.max(10, Math.ceil(s * 0.3)) };
}

function sampleRows(
  db: Database.Database,
  table: AuditTable,
  mode: SampleMode,
): Array<Record<string, unknown>> {
  const tableSize = (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  ).c;

  if (mode === 'full' || tableSize < 1_000) {
    return db.prepare(`SELECT * FROM ${table}`).all() as Array<
      Record<string, unknown>
    >;
  }

  const plan =
    typeof mode === 'number'
      ? { sampleSize: mode, recentMin: Math.max(10, Math.ceil(mode * 0.3)) }
      : computeAdaptiveSampleSize(tableSize);

  const randomCount = Math.ceil(plan.sampleSize * 0.4);
  const bucketCount = Math.ceil(plan.sampleSize * 0.3);
  const recentCount = plan.recentMin;

  const randomRows = db
    .prepare(
      `SELECT * FROM ${table}
        WHERE created_at > datetime('now','-30 days')
        ORDER BY RANDOM() LIMIT ?`,
    )
    .all(randomCount) as Array<Record<string, unknown>>;

  const bucketPerDay = Math.max(1, Math.ceil(bucketCount / 7));
  const bucketRows: Array<Record<string, unknown>> = [];
  for (let n = 0; n < 7; n++) {
    const rows = db
      .prepare(
        `SELECT * FROM ${table}
          WHERE date(created_at) = date('now', ?)
          ORDER BY RANDOM() LIMIT ?`,
      )
      .all(`-${n} days`, bucketPerDay);
    bucketRows.push(...(rows as Array<Record<string, unknown>>));
  }

  const recentRows = db
    .prepare(
      `SELECT * FROM ${table}
        WHERE created_at > datetime('now','-1 day')
        ORDER BY RANDOM() LIMIT ?`,
    )
    .all(recentCount) as Array<Record<string, unknown>>;

  const seen = new Set<unknown>();
  return [...randomRows, ...bucketRows, ...recentRows].filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function verifyRow(row: Record<string, unknown>): {
  ok: boolean;
  expected: string;
  actual: string;
} {
  const expected = String(row.content_hash ?? '');
  const actual = computeContentHash(row);
  return { ok: expected === actual, expected, actual };
}

function tableHasFreshMarkersTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = 'lazyos_audit_fresh_markers'`,
    )
    .get();
  return !!row;
}

function verifyFreshMarkers(
  db: Database.Database,
  table: AuditTable,
): VerifyMismatch[] {
  if (!tableHasFreshMarkersTable(db)) return [];

  const markers = db
    .prepare(
      `SELECT row_id FROM lazyos_audit_fresh_markers
        WHERE table_name = ?
          AND verified = 0
          AND marker_created_at > datetime('now','-25 hours')`,
    )
    .all(table) as Array<{ row_id: number | string }>;

  const mismatches: VerifyMismatch[] = [];
  for (const m of markers) {
    const row = db
      .prepare(`SELECT * FROM ${table} WHERE id = ?`)
      .get(m.row_id) as Record<string, unknown> | undefined;
    if (!row) {
      mismatches.push({
        id: m.row_id,
        reason: 'row-deleted-but-marker-active',
        details: `Append-only invariant broken: ${table}.id=${String(m.row_id)} missing`,
      });
      continue;
    }
    const r = verifyRow(row);
    if (r.ok) {
      db.prepare(
        `UPDATE lazyos_audit_fresh_markers
          SET verified = 1, verified_at = datetime('now')
          WHERE table_name = ? AND row_id = ?`,
      ).run(table, m.row_id);
    } else {
      mismatches.push({
        id: m.row_id,
        reason: 'fresh-marker-mismatch',
        expected: r.expected,
        actual: r.actual,
        details: `Fresh-row mismatch in ${table}.id=${String(m.row_id)} (inserted in last 24h)`,
      });
    }
  }
  return mismatches;
}

/**
 * Verify all (or a sampled subset of) rows of one audit table via
 * content_hash re-compute + canonical-JSON-strip.
 */
export function verifyAuditRows(
  db: Database.Database,
  table: AuditTable,
  options: VerifyOptions = {},
): VerifyResult {
  const start = Date.now();

  // Pre-step: Trigger-Existence-Check (default: ON).
  const triggerCheck =
    options.triggerExistenceCheck === false
      ? { ok: true, missing: [] as string[], foundTriggers: 0, foundViews: 0 }
      : verifyTriggerExistence(db);

  if (!triggerCheck.ok) {
    return {
      totalChecked: 0,
      mismatches: triggerCheck.missing.map((name) => ({
        id: name,
        reason: name.startsWith('view:')
          ? ('view-existence-missing' as const)
          : ('trigger-existence-missing' as const),
        details: `missing schema object: ${name}`,
      })),
      sampleSize: 0,
      tableSize: 0,
      durationMs: Date.now() - start,
      triggerExistenceOk: false,
      triggerExistenceMissing: triggerCheck.missing,
    };
  }

  const mode: SampleMode =
    options.sampling === 'all'
      ? 'full'
      : options.sampleSize
        ? options.sampleSize
        : 'adaptive';

  const rows = sampleRows(db, table, mode);
  const tableSize = (
    db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
  ).c;

  const mismatches: VerifyMismatch[] = [];
  for (const row of rows) {
    const r = verifyRow(row);
    if (!r.ok) {
      mismatches.push({
        id: row.id as number | string,
        reason: 'hash-mismatch',
        expected: r.expected,
        actual: r.actual,
        details: `Row in ${table} with id=${String(row.id)} has tampered content_hash`,
      });
    }
  }

  if (!options.skipFreshMarkers) {
    mismatches.push(...verifyFreshMarkers(db, table));
  }

  return {
    totalChecked: rows.length,
    mismatches,
    sampleSize: rows.length,
    tableSize,
    durationMs: Date.now() - start,
    triggerExistenceOk: true,
    triggerExistenceMissing: [],
  };
}

const AUDITED_TABLES: AuditTable[] = [
  'lazyos_tool_audit',
  'lazyos_bridge_audit',
  'lazyos_spawn_audit',
  'lazyos_spawn_completion',
  'lazyos_audit_verify_log',
  'lazyos_mcp_filter_audit',
  'lazyos_security_override_audit',
  'lazyos_lint_override_audit',
  'lazyos_priority_audit',
];

/**
 * Convenience: verify all 9 audit tables in a single pass.
 * On trigger-existence-failure: aborts the entire pass (hard-abort).
 */
export function verifyAllAuditTables(
  db: Database.Database,
  options: VerifyOptions & {
    trigger: 'cron' | 'operator' | 'operator-override' | 'ci';
    runId?: string;
  },
): {
  runId: string;
  perTable: Partial<Record<AuditTable, VerifyResult>>;
  totalMismatches: number;
  aborted: boolean;
} {
  const runId = options.runId ?? `run-${Date.now()}`;
  const perTable: Partial<Record<AuditTable, VerifyResult>> = {};
  let totalMismatches = 0;
  let aborted = false;

  for (const t of AUDITED_TABLES) {
    // Skip if the table doesn't exist (e.g. test fixture only has some tables).
    const exists = !!db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
      )
      .get(t);
    if (!exists) continue;

    const r = verifyAuditRows(db, t, options);
    perTable[t] = r;
    totalMismatches += r.mismatches.length;
    if (!r.triggerExistenceOk) {
      aborted = true;
      break;
    }
  }

  return { runId, perTable, totalMismatches, aborted };
}
