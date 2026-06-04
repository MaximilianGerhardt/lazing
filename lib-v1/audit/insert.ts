// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// W1.H1 — lib/audit/insert.ts — single canonical Application-Layer Writer
// for all 13 audit-tables (M9 8 + M6 2 + W0 2 + M10 1).
//
// Authority: modules/W1/W1.H1/audit-insert-MODUL-SPEC.md
// Depends: lib/audit/canonical-json.ts (W3.H1)

import type Database from 'better-sqlite3';
import { computeContentHash } from './canonical-json';

/** Allowed audit tables (defense-in-depth — also enforced by SQLite CHECK). */
export type AuditTable =
  | 'lazyos_tool_audit'
  | 'lazyos_bridge_audit'
  | 'lazyos_spawn_audit'
  | 'lazyos_spawn_completion'
  | 'lazyos_audit_verify_log'
  | 'lazyos_mcp_filter_audit'
  | 'lazyos_security_override_audit'
  | 'lazyos_lint_override_audit'
  | 'lazyos_mcp_bypass_state'
  | 'lazyos_priority_audit'
  | 'lazyos_two_factor_tokens'
  | 'lazyos_push_nonce'
  | 'lazyos_bridge_payload';

const ALLOWED_TABLES: ReadonlySet<AuditTable> = new Set<AuditTable>([
  'lazyos_tool_audit',
  'lazyos_bridge_audit',
  'lazyos_spawn_audit',
  'lazyos_spawn_completion',
  'lazyos_audit_verify_log',
  'lazyos_mcp_filter_audit',
  'lazyos_security_override_audit',
  'lazyos_lint_override_audit',
  'lazyos_mcp_bypass_state',
  'lazyos_priority_audit',
  'lazyos_two_factor_tokens',
  'lazyos_push_nonce',
  'lazyos_bridge_payload',
]);

/** Row type per table. Concrete shapes are owned by db/schema/audit. */
export type AuditRowFor<_T extends AuditTable> = Record<string, unknown>;

export interface AuditInsertResult {
  id: number | string;
  content_hash: string;
}

export type AuditInsertErrorCode =
  | 'invalid-table'
  | 'canonical-json-failure'
  | 'check-violation'
  | 'hash-format-violation'
  | 'db-locked'
  | 'not-in-tx'
  | 'unknown-sqlite-error';

export class AuditInsertError extends Error {
  constructor(
    public readonly code: AuditInsertErrorCode,
    public readonly table: AuditTable | string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[AuditInsert/${code}/${table}] ${message}`);
    this.name = 'AuditInsertError';
  }
}

/**
 * Branded same-tx handle. Caller obtains a `BrandedDb` by calling
 * `inAuditTransaction(db, () => { ... })` — type guarantees that
 * `insertAudit` is only callable inside an open transaction.
 */
export type BrandedDb = Database.Database & {
  readonly __auditTxBrand: 'audit-write';
};

/**
 * Run `fn` inside a `db.transaction()` callback, narrowing the database
 * handle to `BrandedDb` so callers can compose `insertAudit` writes inside.
 */
export function inAuditTransaction<R>(
  db: Database.Database,
  fn: (tx: BrandedDb) => R,
): R {
  // better-sqlite3 .transaction returns a wrapper function; calling it runs
  // the callback in a BEGIN/COMMIT block. We pass the same `db` reference
  // (better-sqlite3 transactions reuse the connection) as the BrandedDb.
  const wrapper = db.transaction(() => fn(db as BrandedDb));
  return wrapper();
}

// Prepared-Statement-Cache (per-DB, per-table, per-column-shape).
const stmtCache = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();

function getStmt(
  db: Database.Database,
  table: AuditTable,
  columns: readonly string[],
): Database.Statement {
  let perDb = stmtCache.get(db);
  if (!perDb) {
    perDb = new Map();
    stmtCache.set(db, perDb);
  }
  const key = `${table}::${[...columns].sort().join(',')}`;
  let stmt = perDb.get(key);
  if (!stmt) {
    const cols = columns.join(', ');
    const placeholders = columns.map((c) => `@${c}`).join(', ');
    stmt = db.prepare(
      `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING id, content_hash`,
    );
    perDb.set(key, stmt);
  }
  return stmt;
}

/**
 * Insert one row into an audit table. The caller MUST pass an active
 * `BrandedDb` obtained via `inAuditTransaction(db, ...)` — POS-7 same-tx
 * fail-closed semantics.
 *
 * `content_hash`, `id`, `created_at` are computed/set by this function
 * and MUST NOT be in `row`.
 */
export function insertAudit<T extends AuditTable>(
  tx: BrandedDb,
  table: T,
  row: Omit<AuditRowFor<T>, 'id' | 'content_hash' | 'created_at'>,
): AuditInsertResult {
  // Defense-in-depth: table allowlist.
  if (!ALLOWED_TABLES.has(table)) {
    throw new AuditInsertError('invalid-table', table, 'unknown audit table');
  }

  // Runtime check: are we actually in a tx?
  if (!tx.inTransaction) {
    throw new AuditInsertError(
      'not-in-tx',
      table,
      'insertAudit called outside an open transaction — use inAuditTransaction()',
    );
  }

  // Compute content_hash.
  let content_hash: string;
  try {
    content_hash = computeContentHash(row as Record<string, unknown>);
  } catch (err) {
    throw new AuditInsertError(
      'canonical-json-failure',
      table,
      'cyclic / non-serializable row',
      err,
    );
  }

  // Build payload (id + created_at left to DDL defaults).
  // If caller explicitly provided `content_hash` in `row` it is OVERWRITTEN.
  const payload: Record<string, unknown> = {
    ...(row as Record<string, unknown>),
    content_hash,
  };
  // Remove fields we never want to send in the INSERT statement:
  delete payload.id;
  delete payload.created_at;

  // Drop undefined-valued payload fields so SQLite doesn't see them as
  // missing bind-params (better-sqlite3 throws SqliteError on missing
  // bind keys; explicit removal makes the row shape uniform).
  for (const k of Object.keys(payload)) {
    if (payload[k] === undefined) delete payload[k];
  }

  const columns = Object.keys(payload);
  const stmt = getStmt(tx, table, columns);

  let result: AuditInsertResult;
  try {
    result = stmt.get(payload) as AuditInsertResult;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    if (msg.includes('SQLITE_BUSY') || msg.includes('database is locked')) {
      // Single retry (better-sqlite3 is synchronous; the DB-level
      // busy_timeout pragma handles longer waits — see Wave-0 setup).
      try {
        result = stmt.get(payload) as AuditInsertResult;
      } catch (err2) {
        throw new AuditInsertError(
          'db-locked',
          table,
          'lock-retry-exhausted',
          err2,
        );
      }
    } else if (msg.includes('content_hash must be sha256 hex')) {
      throw new AuditInsertError('hash-format-violation', table, msg, err);
    } else if (msg.includes('CHECK constraint failed')) {
      throw new AuditInsertError('check-violation', table, msg, err);
    } else {
      throw new AuditInsertError('unknown-sqlite-error', table, msg, err);
    }
  }

  return result;
}

/**
 * One-shot variant: opens a transaction, inserts, commits.
 * Use ONLY when the audit-insert is the ONLY DB-write in the TX.
 */
export function insertAuditStandalone<T extends AuditTable>(
  db: Database.Database,
  table: T,
  row: Omit<AuditRowFor<T>, 'id' | 'content_hash' | 'created_at'>,
): AuditInsertResult {
  return inAuditTransaction(db, (tx) => insertAudit(tx, table, row));
}
