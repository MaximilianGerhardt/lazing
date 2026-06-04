// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-EVID-01 — Detail-Ledger Repo.
// Append-only Body-Store. ON CONFLICT idempotency via (workstream_id, content_hash).
// Authority: modules/W2/M-EVID-01/DETAIL-LEDGER-DDL.md (BUG-FIX-1 + BUG-FIX-2 applied).
//
// N1 — payload preserved verbatim (no .slice / .substring).
// N10 — tamper-evident: content_hash = sha256(canonicalize(payload)).

import type Database from 'better-sqlite3';
import { canonicalize } from '../../audit/canonical-json';
import { computeContentHash } from '../../audit/trace-evidence';
import { ulid } from '../../ulid';

export interface AppendLedgerArgs<
  P extends Record<string, unknown> = Record<string, unknown>,
> {
  workstreamId: string;
  payload: P;
  /** Optional override; default = now() from DB clock. */
  createdAt?: number;
}

export interface AppendLedgerResult {
  /** ULID of the canonical row (either new or pre-existing). */
  id: string;
  contentHash: string;
  /** true = a new row was inserted; false = ON CONFLICT DO NOTHING (idempotent). */
  inserted: boolean;
}

export interface SupersedeLedgerArgs {
  workstreamId: string;
  /** ULID of the row being replaced; MUST be current (superseded_at IS NULL). */
  predecessorId: string;
  payload: Record<string, unknown>;
}

export interface LedgerRow {
  id: string;
  workstream_id: string;
  payload_jsonb: string;
  content_hash: string;
  created_at: number;
  superseded_at: number | null;
  superseded_by: string | null;
}

export class WorkstreamDetailLedgerRepo {
  /**
   * BUG-FIX-2 (M-RAG-04 BUG-FIX-1 §3.3): constructor accepts the better-sqlite3
   * Database handle (caller may also pass a TX-scoped handle, since better-sqlite3
   * reuses the connection inside `db.transaction(fn)`).
   */
  constructor(private readonly db: Database.Database) {}

  /**
   * Static helper kept for forward-compat with callers that hold a `Tx` brand.
   */
  static fromTx(
    tx: Database.Database,
  ): WorkstreamDetailLedgerRepo {
    return new WorkstreamDetailLedgerRepo(tx);
  }

  /**
   * Append a payload row. Idempotent via (workstream_id, content_hash).
   *
   * N1: payload preserved verbatim through canonicalize().
   * N10: content_hash = sha256(canonicalize(payload)).
   */
  appendLedger(args: AppendLedgerArgs): AppendLedgerResult {
    const canonical = canonicalize(args.payload);
    const contentHash = computeContentHash(args.payload);
    const createdAt = args.createdAt ?? Math.floor(Date.now() / 1000);

    // Retry on PK collision (ULID monotonic-bucket exhaustion within same ms).
    let insertResult: { id: string } | undefined;
    let lastErr: unknown;
    let candidateId = ulid();
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        insertResult = this.db
          .prepare(
            `INSERT INTO workstream_detail_ledger
               (id, workstream_id, payload_jsonb, content_hash, created_at)
             VALUES (@id, @workstream_id, @payload_jsonb, @content_hash, @created_at)
             ON CONFLICT (workstream_id, content_hash) DO NOTHING
             RETURNING id`,
          )
          .get({
            id: candidateId,
            workstream_id: args.workstreamId,
            payload_jsonb: canonical,
            content_hash: contentHash,
            created_at: createdAt,
          }) as { id: string } | undefined;
        lastErr = undefined;
        break;
      } catch (e) {
        const code = (e as { code?: string } | null)?.code;
        if (
          code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
          code === 'SQLITE_CONSTRAINT_UNIQUE'
        ) {
          lastErr = e;
          candidateId = ulid(Date.now() + attempt + 1);
          continue;
        }
        throw e;
      }
    }
    if (lastErr !== undefined) {
      throw lastErr;
    }

    if (insertResult) {
      return { id: insertResult.id, contentHash, inserted: true };
    }

    // Conflict path — fetch pre-existing id.
    const existing = this.db
      .prepare(
        `SELECT id FROM workstream_detail_ledger
         WHERE workstream_id = ? AND content_hash = ?`,
      )
      .get(args.workstreamId, contentHash) as { id: string } | undefined;

    if (!existing) {
      throw new Error(
        `[M-EVID-01] appendLedger: ON CONFLICT path with no pre-existing row — ` +
          `workstream=${args.workstreamId} hash=${contentHash}`,
      );
    }

    return { id: existing.id, contentHash, inserted: false };
  }

  /**
   * Append a new ledger row that replaces predecessorId.
   * BUG-FIX-1 (CRITIC MUST-FIX-3): pre-check rejects byte-identical payload.
   */
  supersedeLedger(args: SupersedeLedgerArgs): AppendLedgerResult {
    const txFn = this.db.transaction((): AppendLedgerResult => {
      // Step 1 — load predecessor.
      const predecessor = this.db
        .prepare(
          `SELECT content_hash, superseded_at
           FROM workstream_detail_ledger WHERE id = ?`,
        )
        .get(args.predecessorId) as
        | { content_hash: string; superseded_at: number | null }
        | undefined;

      if (!predecessor) {
        throw new InvalidSupersedeError(
          `[M-EVID-01] supersedeLedger: predecessor ${args.predecessorId} not found`,
        );
      }
      if (predecessor.superseded_at !== null) {
        throw new SupersededError(
          `[M-EVID-01] supersedeLedger: predecessor ${args.predecessorId} already superseded`,
        );
      }

      const newContentHash = computeContentHash(args.payload);
      if (newContentHash === predecessor.content_hash) {
        throw new InvalidSupersedeError(
          `[M-EVID-01] supersedeLedger: new payload is byte-identical to predecessor ` +
            `(hash=${newContentHash}). Supersede is a no-op; refusing to write.`,
        );
      }

      // Step 2 — append.
      const appended = this.appendLedger({
        workstreamId: args.workstreamId,
        payload: args.payload,
      });

      if (!appended.inserted) {
        throw new InvalidSupersedeError(
          `[M-EVID-01] supersedeLedger: race detected — payload hash ${newContentHash} ` +
            `was inserted by a concurrent writer; this supersede cannot claim it.`,
        );
      }

      // Step 3 — flip predecessor with CAS guard.
      const update = this.db
        .prepare(
          `UPDATE workstream_detail_ledger
           SET superseded_at = ?, superseded_by = ?
           WHERE id = ? AND superseded_at IS NULL`,
        )
        .run(Math.floor(Date.now() / 1000), appended.id, args.predecessorId);

      if (update.changes === 0) {
        throw new SupersededError(
          `[M-EVID-01] supersedeLedger: predecessor ${args.predecessorId} not current`,
        );
      }
      return appended;
    });
    return txFn();
  }

  /** Return all ledger rows for a workstream, newest first. NEVER truncates payload (N1). */
  getLedger(workstreamId: string): LedgerRow[] {
    return this.db
      .prepare(
        `SELECT id, workstream_id, payload_jsonb, content_hash, created_at,
                superseded_at, superseded_by
         FROM workstream_detail_ledger
         WHERE workstream_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(workstreamId) as LedgerRow[];
  }

  /** Currently-active ledger rows only (superseded_at IS NULL). */
  getCurrentLedger(workstreamId: string): LedgerRow[] {
    return this.db
      .prepare(
        `SELECT id, workstream_id, payload_jsonb, content_hash, created_at,
                superseded_at, superseded_by
         FROM workstream_detail_ledger
         WHERE workstream_id = ? AND superseded_at IS NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(workstreamId) as LedgerRow[];
  }

  /** Lookup by (workstream_id, content_hash). Used for N10 verifyTamperEvidence + M-EVID-04 evidence_refs resolution. */
  findByHash(workstreamId: string, contentHash: string): LedgerRow | undefined {
    return this.db
      .prepare(
        `SELECT id, workstream_id, payload_jsonb, content_hash, created_at,
                superseded_at, superseded_by
         FROM workstream_detail_ledger
         WHERE workstream_id = ? AND content_hash = ?`,
      )
      .get(workstreamId, contentHash) as LedgerRow | undefined;
  }
}

export class SupersededError extends Error {
  readonly code = 'M_EVID_01_SUPERSEDED';
  constructor(message: string) {
    super(message);
    this.name = 'SupersededError';
  }
}

/**
 * Thrown by supersedeLedger when the new payload is structurally invalid as a
 * supersede target. BUG-FIX-1 (CRITIC MUST-FIX-3).
 */
export class InvalidSupersedeError extends Error {
  readonly code = 'M_EVID_01_INVALID_SUPERSEDE';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSupersedeError';
  }
}
