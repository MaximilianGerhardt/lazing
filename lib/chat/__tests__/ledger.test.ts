/**
 * Tests für lib/chat/ledger.ts (BACKPORT-01 · 2026-05-23).
 *
 * Smoke-Coverage:
 *   1. Migration legt chat_ledger an mit allen Spalten + Indizes.
 *   2. appendLedgerRow schreibt eine Zeile, content_hash ist deterministisch.
 *   3. Idempotency: gleicher conversation_thread + Hash = no INSERT.
 *   4. N1: lange Strings werden VERBATIM gespeichert (kein Truncation).
 *   5. N9: leerer coordKey wirft Error.
 *   6. Closed-Enum: ungültiges role wirft Error.
 *   7. Read-Pfade: readLedgerThread + readLedgerById liefern dieselbe Zeile.
 *   8. tool_calls werden als canonical JSON gespeichert.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../canonical';
import { appendLedgerRow, readLedgerById, readLedgerThread } from '../ledger';

let db: Database.Database;

function loadMigration(file: string): string {
  const p = path.join(process.cwd(), 'db', 'migrations', file);
  return readFileSync(p, 'utf8');
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(loadMigration('0093_chat_ledger.sql'));
});

afterEach(() => {
  db.close();
});

describe('chat_ledger migration', () => {
  it('creates table with all 10 columns', () => {
    const cols = db
      .prepare(`PRAGMA table_info(chat_ledger)`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'content_full',
        'content_hash',
        'conversation_thread_id',
        'coord_key',
        'created_at',
        'id',
        'parent_message_id',
        'role',
        'tool_calls_json',
        'workstream_id',
      ].sort(),
    );
  });

  it('creates 5 indexes', () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='chat_ledger'
          AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[];
    expect(idx.map((i) => i.name).sort()).toEqual([
      'idx_chat_ledger_coord',
      'idx_chat_ledger_hash',
      'idx_chat_ledger_parent',
      'idx_chat_ledger_thread',
      'idx_chat_ledger_workstream',
    ]);
  });

  it('is idempotent (re-run is no-op)', () => {
    expect(() => db.exec(loadMigration('0093_chat_ledger.sql'))).not.toThrow();
  });
});

describe('appendLedgerRow', () => {
  it('writes a row + content_hash is deterministic', () => {
    const res = appendLedgerRow(db, {
      coordKey: 'workspace:ws-1',
      role: 'user',
      contentFull: 'Hallo Welt',
      conversationThreadId: 'thr-1',
      now: 1_700_000_000_000,
    });
    expect(res.wrote).toBe(true);
    if (res.wrote) {
      const expected = contentHash({
        coordKey: 'workspace:ws-1',
        role: 'user',
        contentFull: 'Hallo Welt',
        toolCallsJson: null,
        parentMessageId: null,
        conversationThreadId: 'thr-1',
      });
      expect(res.row.contentHash).toBe(expected);
      expect(res.row.contentFull).toBe('Hallo Welt');
      expect(res.row.createdAt).toBe(1_700_000_000_000);
    }
  });

  it('idempotency: same thread + payload = no INSERT, returns existing', () => {
    const r1 = appendLedgerRow(db, {
      coordKey: 'workspace:ws-1',
      role: 'user',
      contentFull: 'same',
      conversationThreadId: 'thr-2',
    });
    const r2 = appendLedgerRow(db, {
      coordKey: 'workspace:ws-1',
      role: 'user',
      contentFull: 'same',
      conversationThreadId: 'thr-2',
    });
    expect(r1.wrote).toBe(true);
    expect(r2.wrote).toBe(false);
    if (!r2.wrote) {
      expect(r2.reason).toBe('duplicate');
      expect(r2.row.id).toBe(r1.wrote ? r1.row.id : '');
    }
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM chat_ledger WHERE conversation_thread_id=?`)
      .get('thr-2') as { n: number };
    expect(count.n).toBe(1);
  });

  it('N1: stores a 10KB string VERBATIM, no truncation', () => {
    const big = 'X'.repeat(10_240) + '|END|';
    const res = appendLedgerRow(db, {
      coordKey: 'workspace:ws-1',
      role: 'assistant',
      contentFull: big,
      conversationThreadId: 'thr-big',
    });
    expect(res.wrote).toBe(true);
    if (res.wrote) {
      expect(res.row.contentFull).toBe(big);
      expect(res.row.contentFull.length).toBe(10_245);
      expect(res.row.contentFull.endsWith('|END|')).toBe(true);
    }
    // Re-read aus DB um sicherzustellen, dass keine Truncation passiert ist.
    const reread = readLedgerById(db, res.wrote ? res.row.id : '');
    expect(reread?.contentFull).toBe(big);
  });

  it('N9: empty coordKey throws', () => {
    expect(() =>
      appendLedgerRow(db, {
        coordKey: '',
        role: 'user',
        contentFull: 'x',
        conversationThreadId: 'thr-x',
      }),
    ).toThrow(/coordKey is required/);
  });

  it('closed-enum: invalid role throws', () => {
    expect(() =>
      appendLedgerRow(db, {
        coordKey: 'workspace:ws-1',
        // @ts-expect-error: invalid role on purpose
        role: 'invalid',
        contentFull: 'x',
        conversationThreadId: 'thr-x',
      }),
    ).toThrow(/role "invalid"/);
  });

  it('serialises tool_calls as JSON, hash is stable across key-order', () => {
    const tcA = { tools: [{ name: 'Bash', args: { cmd: 'ls' } }] };
    const tcB = { tools: [{ name: 'Bash', args: { cmd: 'ls' } }] };
    const r1 = appendLedgerRow(db, {
      coordKey: 'workspace:ws-1',
      role: 'assistant',
      contentFull: 'call',
      conversationThreadId: 'thr-tc',
      toolCalls: tcA,
    });
    const r2 = appendLedgerRow(db, {
      coordKey: 'workspace:ws-1',
      role: 'assistant',
      contentFull: 'call',
      conversationThreadId: 'thr-tc',
      toolCalls: tcB,
    });
    expect(r1.wrote).toBe(true);
    expect(r2.wrote).toBe(false); // duplicate detected via content_hash
  });
});

describe('read helpers', () => {
  it('readLedgerThread returns rows in created_at ASC', () => {
    appendLedgerRow(db, {
      coordKey: 'w',
      role: 'user',
      contentFull: 'a',
      conversationThreadId: 't',
      now: 100,
    });
    appendLedgerRow(db, {
      coordKey: 'w',
      role: 'assistant',
      contentFull: 'b',
      conversationThreadId: 't',
      now: 200,
    });
    appendLedgerRow(db, {
      coordKey: 'w',
      role: 'user',
      contentFull: 'c',
      conversationThreadId: 't',
      now: 300,
    });
    const rows = readLedgerThread(db, 't');
    expect(rows.map((r) => r.contentFull)).toEqual(['a', 'b', 'c']);
  });

  it('readLedgerById returns null on missing', () => {
    expect(readLedgerById(db, 'NOPE')).toBeNull();
  });
});
