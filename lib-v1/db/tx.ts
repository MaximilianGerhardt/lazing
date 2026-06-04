// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// W2.H1 — Transaction-Helper for same-TX SQL sequences in Slice-B.
//
// Wraps better-sqlite3 db.transaction() with three hard-rules that make
// N2 (Same-TX-Fail-Closed) byggetisch unverletzbar:
//   (1) callback must be synchronous
//   (2) only prepared statements allowed (enforced via M-POL-01 lint, not runtime)
//   (3) any throw inside callback triggers automatic ROLLBACK
//
// BUG-FIX-2 applied: generic + commit_denial_only + 5-variant discriminated union
// + 9-value SafeRetrieveFailureReason.
//
// Authority: modules/W2/W2.H1/TX-HELPER-SPEC.md (bug-fix-2 applied).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DatabaseT = any; // better-sqlite3 Database — kept loose to avoid runtime import

/**
 * Branded transaction-handle. Repos accept this in their constructor as a
 * compile-time proof that the caller is inside an `inTransaction`/
 * `inFailClosedTransaction` callback. The brand is structural — a plain
 * better-sqlite3 Database can be cast to Tx via `fromTx` only in the
 * deprecated adapter.
 */
export type Tx = DatabaseT & { readonly __lazyosTxBrand: unique symbol };

/**
 * 9-value failure-reason vocabulary covering production-realistic SQLite
 * failure modes (M-RAG-04 BUG-FIX-1 / B2).
 */
export type SafeRetrieveFailureReason =
  | 'audit_null'
  | 'audit_throw'
  | 'retrieve_throw'
  | 'cross_ws_denied'
  | 'cross_ws_misuse'
  | 'db_busy'
  | 'db_full'
  | 'db_readonly'
  | 'schema_drift'
  | 'oom_recovered'
  | 'denial_write_failed'
  | 'internal';

/** @deprecated BUG-FIX-2: legacy alias. Use SafeRetrieveFailureReason. */
export type FailClosedReason = SafeRetrieveFailureReason;

/**
 * AuditFn return-shape with commit_denial_only branch.
 * commit_denial_only signals "I wrote the denial-row in the SAME TX —
 * commit the TX, skip the evidence INSERT, and surface cross_ws_audit_id".
 * POS-2 same-TX denial contract.
 */
export type AuditFnResult<EvidenceId = string> =
  | {
      evidence_row_id: EvidenceId;
      commit_denial_only?: undefined;
      cross_ws_audit_id?: undefined;
    }
  | {
      evidence_row_id: null;
      commit_denial_only: true;
      cross_ws_audit_id: EvidenceId;
    }
  | {
      evidence_row_id: null;
      commit_denial_only?: undefined;
      cross_ws_audit_id?: undefined;
    };

/**
 * 5-variant discriminated union. Tagged by `kind`.
 *   - 'committed'              — happy path
 *   - 'cross_ws_denied'        — POS-2 same-TX denial commit
 *   - 'fail_closed_audit_null' — auditFn returned null without commit_denial_only
 *   - 'fail_closed_throw'      — retrieveFn or auditFn threw
 *   - 'pre_tx_misuse'          — caller-bug detected before TX opened
 */
export type FailClosedResult<C, EvidenceId = string> =
  | {
      kind: 'committed';
      chunks: C[];
      evidence_row_id: EvidenceId;
      failure_reason: null;
      cause?: undefined;
      cross_ws_audit_id?: undefined;
      commit_denial_only?: undefined;
    }
  | {
      kind: 'cross_ws_denied';
      chunks: [];
      evidence_row_id: null;
      failure_reason: 'cross_ws_denied';
      cause?: unknown;
      cross_ws_audit_id: EvidenceId;
      commit_denial_only: true;
    }
  | {
      kind: 'fail_closed_audit_null';
      chunks: [];
      evidence_row_id: null;
      failure_reason: SafeRetrieveFailureReason;
      cause?: unknown;
      cross_ws_audit_id?: null;
      commit_denial_only?: undefined;
    }
  | {
      kind: 'fail_closed_throw';
      chunks: [];
      evidence_row_id: null;
      failure_reason: SafeRetrieveFailureReason;
      cause: unknown;
      cross_ws_audit_id?: null;
      commit_denial_only?: undefined;
    }
  | {
      kind: 'pre_tx_misuse';
      chunks: [];
      evidence_row_id: null;
      failure_reason: 'cross_ws_misuse' | 'internal';
      cause: unknown;
      cross_ws_audit_id?: null;
      commit_denial_only?: undefined;
    };

export class AsyncTransactionCallbackError extends Error {
  constructor(fnName: string) {
    super(
      `inTransaction callback "${fnName}" is async. ` +
        `better-sqlite3 transactions MUST be synchronous (N2 Same-TX-Fail-Closed). ` +
        `See modules/W2/W2.H1/TX-HELPER-SPEC.md §3 Hard-Rule 1.`,
    );
    this.name = 'AsyncTransactionCallbackError';
  }
}

export class NestedTransactionError extends Error {
  constructor() {
    super(
      `inTransaction called while db.inTransaction === true. ` +
        `better-sqlite3 does not support nested transactions; ` +
        `compose tx-callbacks instead. See §3 Hard-Rule 1 nested-guard.`,
    );
    this.name = 'NestedTransactionError';
  }
}

export class NonPreparedStatementError extends Error {
  constructor(stmt: string) {
    super(
      `Non-prepared SQL detected inside inTransaction: "${stmt.slice(0, 80)}…". ` +
        `Use db.prepare(...) outside the TX and call .run/.get/.all inside. ` +
        `See modules/W2/W2.H1/TX-HELPER-SPEC.md §3 Hard-Rule 2.`,
    );
    this.name = 'NonPreparedStatementError';
  }
}

export class FailClosedAuditError extends Error {
  readonly reason: SafeRetrieveFailureReason;
  override readonly cause?: unknown;
  constructor(reason: SafeRetrieveFailureReason, cause?: unknown) {
    super(
      `FAIL_CLOSED: ${reason}. ` +
        `N2 Same-TX-Fail-Closed triggered; chunks returned as [] to caller. ` +
        `Caller MUST write workstream_decisions row (N8). See §3 Hard-Rule 3.`,
    );
    this.name = 'FailClosedAuditError';
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Run `fn` inside a synchronous SQLite transaction.
 *
 * Hard-Rules:
 *  - `fn` MUST be a synchronous function (4-layer defense — lint + TS + runtime + CI grep).
 *  - Any throw inside `fn` triggers ROLLBACK and re-throws.
 *  - Nested transactions are rejected via NestedTransactionError.
 */
export function inTransaction<T>(db: DatabaseT, fn: () => T): T {
  // Hard-Rule 1a: reject async callbacks at runtime.
  if (fn.constructor.name === 'AsyncFunction') {
    throw new AsyncTransactionCallbackError(fn.name || '<anonymous>');
  }
  // Hard-Rule 1b: reject nested transactions.
  if (db.inTransaction) {
    throw new NestedTransactionError();
  }
  const txFn = db.transaction(fn);
  const result = txFn();
  if (result instanceof Promise) {
    // Defense-in-depth: a sync function that returns a Promise is still a leak.
    throw new AsyncTransactionCallbackError(
      fn.name || '<anonymous-returns-promise>',
    );
  }
  return result;
}

/**
 * Specialized helper for the N2-Same-TX-Fail-Closed pattern used by M-RAG-04.
 * Runs `retrieveFn` then `auditFn` inside the same TX. If `auditFn` throws OR
 * returns evidence_row_id=null without commit_denial_only, the TX rolls back
 * and a typed FailClosedResult is returned.
 */
export function inFailClosedTransaction<C, EvidenceId = string>(
  db: DatabaseT,
  retrieveFn: () => C[],
  auditFn: (chunks: C[]) => AuditFnResult<EvidenceId>,
  onFailClosed?: (err: FailClosedAuditError) => void,
): FailClosedResult<C, EvidenceId> {
  let failure: FailClosedAuditError | null = null;
  let denial: {
    commit_denial_only: true;
    cross_ws_audit_id: EvidenceId;
  } | null = null;
  let committedChunks: C[] = [];
  let committedEvidenceId: EvidenceId | null = null;

  try {
    inTransaction(db, () => {
      let chunks: C[];
      try {
        chunks = retrieveFn();
      } catch (err) {
        failure = new FailClosedAuditError(
          mapSqliteReason(err) ?? 'retrieve_throw',
          err,
        );
        throw failure;
      }
      let audit: AuditFnResult<EvidenceId>;
      try {
        audit = auditFn(chunks);
      } catch (err) {
        failure = new FailClosedAuditError(
          mapSqliteReason(err) ?? 'audit_throw',
          err,
        );
        throw failure;
      }

      // BUG-FIX-2 A1: commit_denial_only path — TX commits despite no evidence.
      if (audit.commit_denial_only === true) {
        denial = {
          commit_denial_only: true,
          cross_ws_audit_id: audit.cross_ws_audit_id,
        };
        return; // TX commits with denial-row INSERTed by auditFn.
      }

      if (audit.evidence_row_id === null) {
        failure = new FailClosedAuditError('audit_null');
        throw failure;
      }
      committedChunks = chunks;
      committedEvidenceId = audit.evidence_row_id;
    });

    // Outside TX. Either committed-happy or committed-denial.
    if (denial !== null) {
      const d = denial as {
        commit_denial_only: true;
        cross_ws_audit_id: EvidenceId;
      };
      return {
        kind: 'cross_ws_denied',
        chunks: [],
        evidence_row_id: null,
        failure_reason: 'cross_ws_denied',
        cross_ws_audit_id: d.cross_ws_audit_id,
        commit_denial_only: true,
      };
    }
    return {
      kind: 'committed',
      chunks: committedChunks,
      evidence_row_id: committedEvidenceId as EvidenceId,
      failure_reason: null,
    };
  } catch (err) {
    if (failure === null) {
      failure = new FailClosedAuditError('internal', err);
    }
    if (onFailClosed) onFailClosed(failure);

    if (failure.reason === 'audit_null') {
      return {
        kind: 'fail_closed_audit_null',
        chunks: [],
        evidence_row_id: null,
        failure_reason: 'audit_null',
        cause: failure.cause,
      };
    }
    if (
      failure.reason === 'cross_ws_misuse' ||
      failure.reason === 'internal'
    ) {
      return {
        kind: 'pre_tx_misuse',
        chunks: [],
        evidence_row_id: null,
        failure_reason: failure.reason,
        cause: failure.cause,
      };
    }
    return {
      kind: 'fail_closed_throw',
      chunks: [],
      evidence_row_id: null,
      failure_reason: failure.reason,
      cause: failure.cause,
    };
  }
}

/**
 * BUG-FIX-2 B2 — map SQLite error-codes to typed SafeRetrieveFailureReason.
 * Returns null if the error is not a recognized SQLite code.
 */
function mapSqliteReason(err: unknown): SafeRetrieveFailureReason | null {
  const code = (err as { code?: string } | null)?.code;
  if (!code) return null;
  switch (code) {
    case 'SQLITE_BUSY':
    case 'SQLITE_BUSY_SNAPSHOT':
    case 'SQLITE_BUSY_TIMEOUT':
      return 'db_busy';
    case 'SQLITE_FULL':
      return 'db_full';
    case 'SQLITE_READONLY':
      return 'db_readonly';
    case 'SQLITE_SCHEMA':
      return 'schema_drift';
    default:
      return null;
  }
}
