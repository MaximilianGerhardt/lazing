/**
 * Tests für lib/chat/streaming-snapshots-v2.ts (BACKPORT-01 · 2026-05-23).
 *
 * Smoke-Coverage:
 *   1. Migration 0094 fügt 5 Spalten an workstreams hinzu.
 *   2. writeSnapshot schreibt + snapshot_at = now.
 *   3. Idempotency: dup-hash skipped, snapshot_at bleibt last-real-change.
 *   4. INV-30: missing workstream row = no-op (no throw).
 *   5. readSnapshot liefert payload + at + contentHash zurück.
 *   6. Tampered JSON (manual UPDATE) → readSnapshot returns null statt throw.
 *   7. writeManifestationPayload speichert canonical-JSON.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readSnapshot,
  writeManifestationPayload,
  writeSnapshot,
  type SnapshotPayload,
} from '../streaming-snapshots-v2';

let db: Database.Database;

function loadMigration(file: string): string {
  return readFileSync(
    path.join(process.cwd(), 'db', 'migrations', file),
    'utf8',
  );
}

function setupWorkstreamsTable(): void {
  // Minimaler workstreams-table-Schema-Stub für Tests — wir brauchen NUR
  // id + updated_at vorhanden, dann das 0094 ALTERs.
  db.exec(`
    CREATE TABLE workstreams (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // 0095 (workstream_snapshots_v2) hat 5 ALTER TABLE + 2 CREATE INDEX —
  // 0094 ist recursive_plans, NICHT snapshots (Label-Korrektur 2026-05-23).
  // SQLite better-sqlite3 .exec läuft multi-statement durch.
  db.exec(loadMigration('0095_workstream_snapshots_v2.sql'));
}

function insertWorkstream(id: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at)
     VALUES (?, 'ws-1', 'test', 'active', ?, ?)`,
  ).run(id, now, now);
}

beforeEach(() => {
  db = new Database(':memory:');
  setupWorkstreamsTable();
});

afterEach(() => {
  db.close();
});

describe('migration 0094', () => {
  it('adds 5 new columns to workstreams', () => {
    const cols = db
      .prepare(`PRAGMA table_info(workstreams)`)
      .all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('snapshot_json')).toBe(true);
    expect(names.has('snapshot_at')).toBe(true);
    expect(names.has('snapshot_content_hash')).toBe(true);
    expect(names.has('manifestation_payload')).toBe(true);
    expect(names.has('manifestation_kind')).toBe(true);
  });
});

describe('writeSnapshot', () => {
  it('writes a new snapshot row', () => {
    insertWorkstream('WS-1');
    const payload: SnapshotPayload = {
      partialText: 'streaming so far...',
      activeTool: null,
      activeStep: null,
      engineId: 'claude-cli',
      status: 'streaming',
    };
    const res = writeSnapshot(db, 'WS-1', payload, 1_700_000_000_000);
    expect(res.wrote).toBe(true);
    if (res.wrote) {
      expect(res.at).toBe(1_700_000_000_000);
      expect(res.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('idempotency: dup-hash skipped, snapshot_at NOT bumped', () => {
    insertWorkstream('WS-1');
    const payload: SnapshotPayload = {
      partialText: 'X',
      activeTool: null,
      activeStep: null,
      engineId: 'claude-cli',
      status: 'streaming',
    };
    const r1 = writeSnapshot(db, 'WS-1', payload, 1000);
    const r2 = writeSnapshot(db, 'WS-1', payload, 2000);
    expect(r1.wrote).toBe(true);
    expect(r2.wrote).toBe(false);
    if (!r2.wrote) expect(r2.reason).toBe('duplicate');
    // Read back to check snapshot_at NICHT gebumpt.
    const read = readSnapshot(db, 'WS-1');
    expect(read?.at).toBe(1000);
  });

  it('writes again when payload differs', () => {
    insertWorkstream('WS-1');
    const p1: SnapshotPayload = {
      partialText: 'A',
      activeTool: null,
      activeStep: null,
      engineId: 'claude-cli',
      status: 'streaming',
    };
    const p2: SnapshotPayload = { ...p1, partialText: 'AB' };
    writeSnapshot(db, 'WS-1', p1, 1000);
    const r = writeSnapshot(db, 'WS-1', p2, 2000);
    expect(r.wrote).toBe(true);
    const read = readSnapshot(db, 'WS-1');
    expect(read?.payload.partialText).toBe('AB');
    expect(read?.at).toBe(2000);
  });

  it('INV-30: missing workstream row is no-op (no throw)', () => {
    const r = writeSnapshot(db, 'NOT-EXISTS', {
      partialText: 'x',
      activeTool: null,
      activeStep: null,
      engineId: 'claude-cli',
      status: 'streaming',
    });
    expect(r.wrote).toBe(false);
    if (!r.wrote) expect(r.reason).toBe('workstream-not-found');
  });
});

describe('readSnapshot', () => {
  it('returns null when no snapshot has been written', () => {
    insertWorkstream('WS-1');
    expect(readSnapshot(db, 'WS-1')).toBeNull();
  });

  it('returns null on tampered JSON (no throw)', () => {
    insertWorkstream('WS-1');
    writeSnapshot(db, 'WS-1', {
      partialText: 'x',
      activeTool: null,
      activeStep: null,
      engineId: 'claude-cli',
      status: 'streaming',
    });
    // Tamper.
    db.prepare(`UPDATE workstreams SET snapshot_json = ? WHERE id = ?`).run(
      'NOT-JSON{',
      'WS-1',
    );
    expect(readSnapshot(db, 'WS-1')).toBeNull();
  });
});

describe('writeManifestationPayload', () => {
  it('persists canonical-JSON + manifestation_kind', () => {
    insertWorkstream('WS-1');
    const payload = { items: [{ id: 'a' }, { id: 'b' }] };
    const r = writeManifestationPayload(db, 'WS-1', 'plan-board', payload);
    expect(r.wrote).toBe(true);
    const row = db
      .prepare(`SELECT manifestation_payload, manifestation_kind FROM workstreams WHERE id=?`)
      .get('WS-1') as { manifestation_payload: string; manifestation_kind: string };
    expect(row.manifestation_kind).toBe('plan-board');
    expect(JSON.parse(row.manifestation_payload)).toEqual(payload);
  });

  it('idempotency on identical canonical JSON', () => {
    insertWorkstream('WS-1');
    const r1 = writeManifestationPayload(db, 'WS-1', 'composer', { x: 1, y: 2 });
    const r2 = writeManifestationPayload(db, 'WS-1', 'composer', { y: 2, x: 1 });
    expect(r1.wrote).toBe(true);
    expect(r2.wrote).toBe(false);
    expect(r2.reason).toBe('duplicate');
  });
});
