/**
 * lib/chat/streaming-snapshots-v2.ts
 * (BACKPORT-01 · 2026-05-23, Quelle: Lazing-V2 packages/runtime/src/streaming/snapshots.ts)
 *
 * V2-Streaming-Snapshots persistieren den live-Streaming-State auf der
 * EXISTIERENDEN `workstreams`-Tabelle (additive Spalten aus Migration
 * 0094). Im Unterschied zur älteren `streaming_snapshots`-Tabelle
 * (0018, ephemeral) ist V2:
 *
 *   - N10-tamper-evident (content_hash über canonical-json)
 *   - Idempotent (dup-hash → no-op, snapshot_at bleibt last-real-change)
 *   - INV-30 disconnect-survives (engine läuft weiter, Snapshot wird
 *     bis `done`/`error` geschrieben)
 *
 * Die alte 0018-Tabelle bleibt für die agent-server-Recovery erhalten
 * (server/streaming-snapshots.ts schreibt dort weiter). V2 ist parallel,
 * nicht ersetzend — der App-Server kann mit beidem leben bis Gap-6 die
 * Migration komplettiert.
 *
 * N1: partial_text und payload-Strings werden VERBATIM durchgereicht. Es
 * gibt keinen Code-Pfad hier der .slice/.substring auf payload-text macht.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

import { canonicalJson, contentHash } from './canonical';

/** Closed engine-status enum — mirror of V2 source. */
export type SnapshotStatus = 'streaming' | 'tool-call' | 'recovering' | 'done' | 'error';

/**
 * Canonical snapshot payload — persistiert nach `workstreams.snapshot_json`.
 * Spiegelt das SSE-`snapshot`-Event eins-zu-eins für nahtlose Reconnect-Replay.
 */
export interface SnapshotPayload {
  /** N1: full partial text, NIE truncated. */
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

/** Read-result — null wenn keine snapshot je geschrieben. */
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
 * UPDATE `workstreams.snapshot_*` mit canonical-projection von `payload`.
 * Idempotent auf content-hash; missing row ist no-op (engine continues even
 * after operator deleted the workstream mid-stream — INV-30).
 *
 * Der Hash wird über `canonicalJson(payload)` berechnet — NICHT über die
 * Row, die den Hash bereits enthält, weil der Hash IS der Row-Fingerprint.
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
    // No state change — skip update, snapshot_at bleibt last-real-change.
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
 * Read most-recent snapshot. Returns null wenn row nicht existiert ODER
 * snapshot fields alle null sind (engine hat nie geschrieben).
 *
 * Tampered JSON (operator hat row angefasst) wird als "no snapshot"
 * behandelt — keine Exception nach außen.
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
 * N1: payload bleibt verbatim canonical-json. NIE truncate.
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
  // Idempotency: gleicher canonical-json + kind = no-op.
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
