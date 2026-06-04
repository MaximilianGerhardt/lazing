// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt

import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  insertAuditStandalone,
} from './insert';
import {
  computeAdaptiveSampleSize,
  verifyAuditRows,
  verifyTriggerExistence,
} from './verify';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 1000');
  db.exec(`
    CREATE TABLE lazyos_tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      tool_class TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      decision TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('W1.H2 audit/verify', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('P1: 10 valid rows verify with 0 mismatches', () => {
    for (let i = 0; i < 10; i++) {
      insertAuditStandalone(db, 'lazyos_tool_audit', {
        workspace_id: 'ws',
        actor_kind: 'agent',
        actor_id: `a-${i}`,
        tool_class: 'Bash',
        tool_name: `cmd-${i}`,
        decision: 'allowed',
        permission_mode: 'freerein',
      });
    }
    const result = verifyAuditRows(db, 'lazyos_tool_audit', {
      sampling: 'all',
      triggerExistenceCheck: false,
      skipFreshMarkers: true,
    });
    expect(result.totalChecked).toBe(10);
    expect(result.mismatches.length).toBe(0);
    expect(result.tableSize).toBe(10);
  });

  test('N1: tampered row detected as hash-mismatch', () => {
    const ins = insertAuditStandalone(db, 'lazyos_tool_audit', {
      workspace_id: 'ws',
      actor_kind: 'agent',
      actor_id: 'a-1',
      tool_class: 'Bash',
      tool_name: 'cmd',
      decision: 'allowed',
      permission_mode: 'freerein',
    });
    // Tamper-via direct update (in real life this would be blocked by the
    // no_update trigger; here we bypass to simulate writable_schema attack).
    db.prepare(
      `UPDATE lazyos_tool_audit SET tool_name = 'TAMPERED' WHERE id = ?`,
    ).run(ins.id);
    const result = verifyAuditRows(db, 'lazyos_tool_audit', {
      sampling: 'all',
      triggerExistenceCheck: false,
      skipFreshMarkers: true,
    });
    expect(result.mismatches.length).toBe(1);
    expect(result.mismatches[0]!.reason).toBe('hash-mismatch');
    expect(result.mismatches[0]!.expected).not.toBe(
      result.mismatches[0]!.actual,
    );
  });

  test('Trigger-existence-check: no triggers → abort + missing list', () => {
    // Fresh DB has no audit-triggers — verifyTriggerExistence reports missing.
    const result = verifyAuditRows(db, 'lazyos_tool_audit', {
      sampling: 'all',
      triggerExistenceCheck: true,
      skipFreshMarkers: true,
    });
    expect(result.triggerExistenceOk).toBe(false);
    expect(result.triggerExistenceMissing.length).toBeGreaterThan(0);
    expect(result.totalChecked).toBe(0);
  });

  test('verifyTriggerExistence after trigger creation: ok = true', () => {
    // Create the 24 triggers + 1 view (no-op bodies — only existence is asked).
    const tables = [
      'lazyos_tool_audit',
      'lazyos_bridge_audit',
      'lazyos_spawn_audit',
      'lazyos_spawn_completion',
      'lazyos_audit_verify_log',
      'lazyos_mcp_filter_audit',
      'lazyos_security_override_audit',
      'lazyos_lint_override_audit',
    ];
    // The other tables don't physically exist in this test DB; we only need
    // CREATE TRIGGER on lazyos_tool_audit (already in schema). Create
    // stub-tables for the others.
    for (const t of tables) {
      if (t === 'lazyos_tool_audit') continue;
      db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY, content_hash TEXT)`);
    }
    for (const t of tables) {
      for (const kind of ['no_update', 'no_delete', 'hash_format']) {
        db.exec(
          `CREATE TRIGGER ${t}_${kind} BEFORE INSERT ON ${t} BEGIN SELECT 1; END;`,
        );
      }
    }
    db.exec(
      `CREATE VIEW lazyos_security_override_active AS SELECT 1 AS x`,
    );
    const check = verifyTriggerExistence(db);
    expect(check.ok).toBe(true);
    expect(check.missing).toEqual([]);
  });

  test('Adaptive sample-size tiers', () => {
    expect(computeAdaptiveSampleSize(500).sampleSize).toBe(500);
    const tier2 = computeAdaptiveSampleSize(5_000);
    expect(tier2.sampleSize).toBeGreaterThanOrEqual(100);
    expect(tier2.sampleSize).toBeLessThanOrEqual(200);
    const tier3 = computeAdaptiveSampleSize(200_000);
    expect(tier3.sampleSize).toBeGreaterThanOrEqual(1_000);
    const tier4 = computeAdaptiveSampleSize(5_000_000);
    expect(tier4.sampleSize).toBeGreaterThanOrEqual(10_000);
  });

  test('triggerExistenceCheck: false → continues without check', () => {
    insertAuditStandalone(db, 'lazyos_tool_audit', {
      workspace_id: 'ws',
      actor_kind: 'agent',
      actor_id: 'a-1',
      tool_class: 'Bash',
      tool_name: 'cmd',
      decision: 'allowed',
      permission_mode: 'freerein',
    });
    const result = verifyAuditRows(db, 'lazyos_tool_audit', {
      sampling: 'all',
      triggerExistenceCheck: false,
      skipFreshMarkers: true,
    });
    expect(result.triggerExistenceOk).toBe(true);
    expect(result.mismatches.length).toBe(0);
  });

  test('S1: self-hash recursion on lazyos_audit_verify_log row', () => {
    // Add the verify-log table to this fresh DB.
    db.exec(`
      CREATE TABLE lazyos_audit_verify_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        verify_run_id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        sample_size INTEGER NOT NULL,
        verified_ok INTEGER NOT NULL,
        mismatches_count INTEGER NOT NULL,
        mismatch_row_ids TEXT,
        trigger TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    insertAuditStandalone(db, 'lazyos_audit_verify_log', {
      verify_run_id: 'r1',
      table_name: 'lazyos_tool_audit',
      sample_size: 1,
      verified_ok: 1,
      mismatches_count: 0,
      mismatch_row_ids: null,
      trigger: 'cron',
      duration_ms: 5,
    });
    const r = verifyAuditRows(db, 'lazyos_audit_verify_log', {
      sampling: 'all',
      triggerExistenceCheck: false,
      skipFreshMarkers: true,
    });
    expect(r.mismatches.length).toBe(0);
    expect(r.totalChecked).toBe(1);
  });
});
