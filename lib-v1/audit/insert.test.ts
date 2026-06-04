// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// W1.H1 — audit/insert tests (M9 DDLS §6 + sec §6 of audit-insert SPEC).
// Uses in-memory better-sqlite3 with a minimal `lazyos_tool_audit` schema.

import { describe, expect, test, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  insertAudit,
  insertAuditStandalone,
  inAuditTransaction,
  AuditInsertError,
} from './insert';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('busy_timeout = 1000');
  db.pragma('foreign_keys = ON');
  // Minimal schema for the test rows.
  db.exec(`
    CREATE TABLE lazyos_tool_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','agent','system')),
      actor_id TEXT NOT NULL,
      tool_class TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allowed','denied','bypassed')),
      permission_mode TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

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
      content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('W1.H1 audit/insert', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  test('positive insert into lazyos_tool_audit returns id + content_hash (64 hex)', () => {
    const result = insertAuditStandalone(db, 'lazyos_tool_audit', {
      workspace_id: 'ws-1',
      actor_kind: 'agent',
      actor_id: 'a-1',
      tool_class: 'Bash',
      tool_name: 'pnpm test',
      decision: 'allowed',
      permission_mode: 'freerein',
    });
    expect(typeof result.id).toBe('number');
    expect(result.id).toBeGreaterThan(0);
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('D1 determinism: same row in different key-order yields same hash', () => {
    const a = insertAuditStandalone(db, 'lazyos_tool_audit', {
      workspace_id: 'ws-1',
      actor_kind: 'agent',
      actor_id: 'a-1',
      tool_class: 'Bash',
      tool_name: 'cmd',
      decision: 'allowed',
      permission_mode: 'freerein',
    });
    const b = insertAuditStandalone(db, 'lazyos_tool_audit', {
      tool_name: 'cmd',
      decision: 'allowed',
      permission_mode: 'freerein',
      tool_class: 'Bash',
      actor_id: 'a-1',
      actor_kind: 'agent',
      workspace_id: 'ws-1',
    });
    expect(a.content_hash).toBe(b.content_hash);
  });

  test('F1: caller-supplied content_hash is OVERWRITTEN', () => {
    const result = insertAuditStandalone(db, 'lazyos_tool_audit', {
      workspace_id: 'ws-1',
      actor_kind: 'agent',
      actor_id: 'a-1',
      tool_class: 'Bash',
      tool_name: 'cmd',
      decision: 'allowed',
      permission_mode: 'freerein',
      content_hash: 'BAD-HASH',
    } as unknown as Record<string, unknown>);
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.content_hash).not.toBe('BAD-HASH');
  });

  test('F2: cyclic-row throws canonical-json-failure', () => {
    const row: Record<string, unknown> = {
      workspace_id: 'ws-1',
      actor_kind: 'agent',
      actor_id: 'a-1',
      tool_class: 'Bash',
      tool_name: 'cmd',
      decision: 'allowed',
      permission_mode: 'freerein',
    };
    row['self'] = row;
    expect(() =>
      insertAuditStandalone(db, 'lazyos_tool_audit', row),
    ).toThrow(/canonical-json-failure/);
  });

  test('F3: unknown table throws invalid-table', () => {
    expect(() =>
      insertAuditStandalone(db, 'lazyos_nonsense' as never, { x: 1 }),
    ).toThrow(/invalid-table/);
  });

  test('F4: CHECK-constraint violation maps to check-violation', () => {
    expect(() =>
      insertAuditStandalone(db, 'lazyos_tool_audit', {
        workspace_id: 'ws-1',
        actor_kind: 'agent',
        actor_id: 'a-1',
        tool_class: 'Bash',
        tool_name: 'cmd',
        decision: 'nonsense' as unknown as string,
        permission_mode: 'freerein',
      }),
    ).toThrow(/check-violation/);
  });

  test('TX1: insertAudit outside transaction throws not-in-tx', () => {
    expect(() =>
      // Bypass the brand at runtime; the inTransaction property is false.
      insertAudit(db as unknown as never, 'lazyos_tool_audit', {
        workspace_id: 'ws-1',
        actor_kind: 'agent',
        actor_id: 'a-1',
        tool_class: 'Bash',
        tool_name: 'cmd',
        decision: 'allowed',
        permission_mode: 'freerein',
      } as Record<string, unknown>),
    ).toThrow(/not-in-tx/);
  });

  test('TX2: side-effect rollback also rolls back audit insert', () => {
    expect(() =>
      inAuditTransaction(db, (tx) => {
        insertAudit(tx, 'lazyos_tool_audit', {
          workspace_id: 'ws-1',
          actor_kind: 'agent',
          actor_id: 'a-1',
          tool_class: 'Bash',
          tool_name: 'cmd',
          decision: 'allowed',
          permission_mode: 'freerein',
        });
        throw new Error('side-effect failed');
      }),
    ).toThrow('side-effect failed');
    const count = (
      db.prepare('SELECT COUNT(*) AS c FROM lazyos_tool_audit').get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  test('insert into lazyos_audit_verify_log (self-hash)', () => {
    const result = insertAuditStandalone(db, 'lazyos_audit_verify_log', {
      verify_run_id: 'run-1',
      table_name: 'lazyos_tool_audit',
      sample_size: 100,
      verified_ok: 100,
      mismatches_count: 0,
      mismatch_row_ids: null,
      trigger: 'cron',
      duration_ms: 12,
    });
    expect(result.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('AuditInsertError carries code property', () => {
    try {
      insertAuditStandalone(db, 'lazyos_nonsense' as never, { x: 1 });
    } catch (e) {
      expect(e).toBeInstanceOf(AuditInsertError);
      expect((e as AuditInsertError).code).toBe('invalid-table');
    }
  });
});
