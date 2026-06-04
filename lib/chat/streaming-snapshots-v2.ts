/**
 * lib/chat/streaming-snapshots-v2.ts
 * (BACKPORT-01 · 2026-05-23, source: Lazing-V2 packages/runtime/src/streaming/snapshots.ts)
 *
 * V2 streaming snapshots persist the live streaming state on the
 * EXISTING `workstreams` table (additive columns from migration
 * 0094). In contrast to the older `streaming_snapshots` table
 * (0018, ephemeral), V2 is:
 *
 *   - N10-tamper-evident (content_hash over canonical-json)
 *   - idempotent (dup-hash → no-op, snapshot_at stays at the last real change)
 *   - INV-30 disconnect-survives (the engine keeps running, the snapshot is
 *     written until `done`/`error`)
 *
 * The old 0018 table remains for the agent-server recovery
 * (server/streaming-snapshots.ts keeps writing there). V2 is parallel,
 * not replacing — the app server can live with both until Gap-6 completes the
 * migration.
 *
 * N1: partial_text and payload strings are passed through VERBATIM. There
 * is no code path here that does .slice/.substring on the payload text.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

import { canonicalJson, contentHash } from './canonical';

/** Closed engine-status enum — mirror of V2 source. */
export type SnapshotStatus = 'streaming' | 'tool-call' | 'recovering' | 'done' | 'error';

/**
 * Canonical snapshot payload — persisted to `workstreams.snapshot_json`.
 * Mirrors the SSE `snapshot` event one-to-one for seamless reconnect replay.
 */
export interface SnapshotPayload {
  /** N1: full partial text, NEVER truncated. */
  readonly partialText: string;
  readonly activeTool: string | null;
  readonly activeStep: string | null;
  readonly engineId: string;
  readonly workstreamId?: string;
  readonly pendingPromptId?: string;
  readonly resultEventId?: string | null;
  readonly status: SnapshotStatus;
}

/** Write-result — discriminated on `wrote`. */
export type WriteSnapshotResult =
  | { readonly wrote: true; readonly contentHash: string; readonly at: number }
  | {
      readonly wrote: false;
      readonly contentHash: string;
      readonly reason: 'duplicate' | 'workstream-not-found' | 'db-error';
      readonly error?: string;
    };

/** Read result — null if no snapshot was ever written. */
export interface ReadSnapshotResult {
  readonly payload: SnapshotPayload;
  readonly at: number;
  readonly contentHash: string;
}

interface ExistingHashRow {
  readonly snapshot_content_hash: string | null;
}

interface ReadRow {
  readonly snapshot_json: string | null;
  readonly snapshot_at: number | null;
  readonly snapshot_content_hash: string | null;
}

/**
 * UPDATE `workstreams.snapshot_*` with the canonical projection of `payload`.
 * Idempotent on content-hash; a missing row is a no-op (engine continues even
 * after operator deleted the workstream mid-stream — INV-30).
 *
 * The hash is computed over `canonicalJson(payload)` — NOT over the
 * row, which already contains the hash, because the hash IS the row fingerprint.
 */
export function writeSnapshot(
  db: BetterSqliteDatabase,
  workstreamId: string,
  payload: SnapshotPayload,
  now: number = Date.now(),
): WriteSnapshotResult {
  const hash = contentHash(payload);

  // Fail-safe: a deleted workstream row must not crash the engine.
  let existing: ExistingHashRow | undefined;
  try {
    existing = db
      .prepare(`SELECT snapshot_content_hash FROM workstreams WHERE id = ?`)
      .get(workstreamId) as ExistingHashRow | undefined;
  } catch (err: unknown) {
    return {
      wrote: false,
      contentHash: hash,
      reason: 'db-error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (existing === undefined) {
    return {
      wrote: false,
      contentHash: hash,
      reason: 'workstream-not-found',
    };
  }

  if (existing.snapshot_content_hash === hash) {
    // No state change — skip update, snapshot_at stays at the last real change.
    return { wrote: false, contentHash: hash, reason: 'duplicate' };
  }

  const json = canonicalJson(payload);
  try {
    db.prepare(
      `UPDATE workstreams
         SET snapshot_json = ?,
             snapshot_at = ?,
             snapshot_content_hash = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(json, now, hash, now, workstreamId);
  } catch (err: unknown) {
    return {
      wrote: false,
      contentHash: hash,
      reason: 'db-error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { wrote: true, contentHash: hash, at: now };
}

/**
 * Read the most-recent snapshot. Returns null if the row does not exist OR
 * the snapshot fields are all null (the engine never wrote).
 *
 * Tampered JSON (operator touched the row) is treated as "no snapshot"
 * — no exception to the outside.
 */
export function readSnapshot(
  db: BetterSqliteDatabase,
  workstreamId: string,
): ReadSnapshotResult | null {
  let row: ReadRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT snapshot_json, snapshot_at, snapshot_content_hash
           FROM workstreams
          WHERE id = ?`,
      )
      .get(workstreamId) as ReadRow | undefined;
  } catch {
    return null;
  }
  if (
    row === undefined ||
    row.snapshot_json === null ||
    row.snapshot_at === null ||
    row.snapshot_content_hash === null
  ) {
    return null;
  }
  let payload: SnapshotPayload;
  try {
    payload = JSON.parse(row.snapshot_json) as SnapshotPayload;
  } catch {
    return null;
  }
  return {
    payload,
    at: row.snapshot_at,
    contentHash: row.snapshot_content_hash,
  };
}

/**
 * Write the operator-confirmed manifestation surface payload + kind.
 * Used by Slice SURFACE-PERSIST — operator confirms a surface (composer,
 * plan-board, etc.) and we cache the verbatim JSON so a re-open doesn't
 * have to re-run the engine.
 *
 * N1: payload stays verbatim canonical-json. NEVER truncate.
 */
export function writeManifestationPayload(
  db: BetterSqliteDatabase,
  workstreamId: string,
  manifestationKind: string,
  payload: unknown,
  now: number = Date.now(),
): { wrote: boolean; contentHash: string; reason?: string } {
  const json = canonicalJson(payload);
  const hash = contentHash({ workstreamId, manifestationKind, payload });

  let row: { manifestation_payload: string | null } | undefined;
  try {
    row = db
      .prepare(`SELECT manifestation_payload FROM workstreams WHERE id = ?`)
      .get(workstreamId) as { manifestation_payload: string | null } | undefined;
  } catch (err) {
    return {
      wrote: false,
      contentHash: hash,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (row === undefined) {
    return { wrote: false, contentHash: hash, reason: 'workstream-not-found' };
  }
  // Idempotency: same canonical-json + kind = no-op.
  if (row.manifestation_payload === json) {
    return { wrote: false, contentHash: hash, reason: 'duplicate' };
  }

  try {
    db.prepare(
      `UPDATE workstreams
         SET manifestation_payload = ?,
             manifestation_kind = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(json, manifestationKind, now, workstreamId);
  } catch (err) {
    return {
      wrote: false,
      contentHash: hash,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { wrote: true, contentHash: hash };
}
