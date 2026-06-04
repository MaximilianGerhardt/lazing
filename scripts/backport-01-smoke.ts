/**
 * scripts/backport-01-smoke.ts — BACKPORT-01 standalone smoke
 *
 * Verifiziert chat_ledger + streaming-snapshots-v2 ohne vitest-Toolchain
 * (rolldown-Binding ist auf diesem Mac kaputt — siehe BACKPORT-01-LIVE).
 *
 * Lauf:  npx tsx scripts/backport-01-smoke.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { canonicalJson, contentHash } from '../lib/chat/canonical';
import { appendLedgerRow, readLedgerById, readLedgerThread } from '../lib/chat/ledger';
import {
  readSnapshot,
  writeManifestationPayload,
  writeSnapshot,
  type SnapshotPayload,
} from '../lib/chat/streaming-snapshots-v2';

const checks: Array<{ name: string; pass: boolean; detail?: string }> = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    checks.push({ name, pass: true });
  } catch (err) {
    checks.push({
      name,
      pass: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function loadMigration(file: string): string {
  return readFileSync(path.join(process.cwd(), 'db', 'migrations', file), 'utf8');
}

// ─── canonical.ts ───────────────────────────────────────────────────────
check('canonicalJson sorts keys alphabetically', () => {
  assert(
    canonicalJson({ b: 1, a: 2 }) === canonicalJson({ a: 2, b: 1 }),
    'order mismatch',
  );
});

check('contentHash is 64-char lowercase hex', () => {
  const h = contentHash({ a: 1 });
  assert(/^[0-9a-f]{64}$/.test(h), `bad hex: ${h}`);
});

check('contentHash matches sha256("{}")', () => {
  const expected =
    '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
  assert(contentHash({}) === expected, `got ${contentHash({})}`);
});

check('canonicalJson throws on NaN', () => {
  let threw = false;
  try {
    canonicalJson({ x: NaN });
  } catch {
    threw = true;
  }
  assert(threw, 'should have thrown');
});

// ─── chat_ledger ────────────────────────────────────────────────────────
const ldb = new Database(':memory:');
ldb.exec(loadMigration('0093_chat_ledger.sql'));

check('migration 0093 creates chat_ledger with 10 cols', () => {
  const cols = ldb
    .prepare(`PRAGMA table_info(chat_ledger)`)
    .all() as { name: string }[];
  assert(cols.length === 10, `expected 10 cols, got ${cols.length}`);
});

check('migration 0093 is idempotent', () => {
  ldb.exec(loadMigration('0093_chat_ledger.sql'));
});

check('appendLedgerRow writes a row and returns the hash', () => {
  const res = appendLedgerRow(ldb, {
    coordKey: 'workspace:ws-1',
    role: 'user',
    contentFull: 'Hallo Welt',
    conversationThreadId: 'thr-1',
    now: 1_700_000_000_000,
  });
  assert(res.wrote, 'should wrote=true');
  if (res.wrote) {
    assert(res.row.contentFull === 'Hallo Welt', 'contentFull mismatch');
    assert(/^[0-9a-f]{64}$/.test(res.row.contentHash), 'bad hash');
  }
});

check('idempotency: dup payload returns wrote=false', () => {
  const a = appendLedgerRow(ldb, {
    coordKey: 'w',
    role: 'user',
    contentFull: 'same',
    conversationThreadId: 'thr-dup',
  });
  const b = appendLedgerRow(ldb, {
    coordKey: 'w',
    role: 'user',
    contentFull: 'same',
    conversationThreadId: 'thr-dup',
  });
  assert(a.wrote && !b.wrote, 'a.wrote/b.wrote mismatch');
  const count = ldb
    .prepare(`SELECT COUNT(*) AS n FROM chat_ledger WHERE conversation_thread_id=?`)
    .get('thr-dup') as { n: number };
  assert(count.n === 1, `expected 1, got ${count.n}`);
});

check('N1: 10KB string stored VERBATIM', () => {
  const big = 'X'.repeat(10_240) + '|END|';
  const r = appendLedgerRow(ldb, {
    coordKey: 'w',
    role: 'assistant',
    contentFull: big,
    conversationThreadId: 'thr-big',
  });
  assert(r.wrote, 'wrote=false');
  if (r.wrote) {
    const reread = readLedgerById(ldb, r.row.id);
    assert(reread !== null, 'reread null');
    assert(reread!.contentFull === big, 'truncated');
    assert(reread!.contentFull.length === 10_245, 'wrong length');
  }
});

check('N9: empty coordKey throws', () => {
  let threw = false;
  try {
    appendLedgerRow(ldb, {
      coordKey: '',
      role: 'user',
      contentFull: 'x',
      conversationThreadId: 't',
    });
  } catch {
    threw = true;
  }
  assert(threw, 'should throw');
});

check('readLedgerThread returns ASC order', () => {
  appendLedgerRow(ldb, {
    coordKey: 'w',
    role: 'user',
    contentFull: 'a',
    conversationThreadId: 'thr-order',
    now: 100,
  });
  appendLedgerRow(ldb, {
    coordKey: 'w',
    role: 'assistant',
    contentFull: 'b',
    conversationThreadId: 'thr-order',
    now: 200,
  });
  const rows = readLedgerThread(ldb, 'thr-order');
  assert(rows.length === 2, `got ${rows.length}`);
  assert(rows[0].contentFull === 'a' && rows[1].contentFull === 'b', 'order');
});

ldb.close();

// ─── streaming-snapshots-v2 ─────────────────────────────────────────────
const sdb = new Database(':memory:');
sdb.exec(`
  CREATE TABLE workstreams (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
sdb.exec(loadMigration('0095_workstream_snapshots_v2.sql'));

sdb
  .prepare(
    `INSERT INTO workstreams (id, workspace_id, name, status, created_at, updated_at)
     VALUES (?, 'ws-1', 't', 'active', ?, ?)`,
  )
  .run('WS-1', 1, 1);

check('migration 0095 adds 5 columns to workstreams', () => {
  const cols = sdb
    .prepare(`PRAGMA table_info(workstreams)`)
    .all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  for (const n of [
    'snapshot_json',
    'snapshot_at',
    'snapshot_content_hash',
    'manifestation_payload',
    'manifestation_kind',
  ]) {
    assert(names.has(n), `missing col ${n}`);
  }
});

const payload: SnapshotPayload = {
  partialText: 'streaming…',
  activeTool: null,
  activeStep: null,
  engineId: 'claude-cli',
  status: 'streaming',
};

check('writeSnapshot inserts payload + content_hash', () => {
  const r = writeSnapshot(sdb, 'WS-1', payload, 1000);
  assert(r.wrote, 'wrote=false');
  if (r.wrote) {
    assert(r.at === 1000, `at=${r.at}`);
    assert(/^[0-9a-f]{64}$/.test(r.contentHash), 'bad hash');
  }
});

check('idempotency: dup-hash skipped, snapshot_at NOT bumped', () => {
  const r = writeSnapshot(sdb, 'WS-1', payload, 9999);
  assert(!r.wrote, 'should be skip');
  const back = readSnapshot(sdb, 'WS-1');
  assert(back !== null && back.at === 1000, `at=${back?.at}`);
});

check('different payload triggers UPDATE', () => {
  const r = writeSnapshot(
    sdb,
    'WS-1',
    { ...payload, partialText: 'streaming… more' },
    2000,
  );
  assert(r.wrote, 'should write');
});

check('INV-30: missing workstream = no throw', () => {
  const r = writeSnapshot(sdb, 'NOT-EXISTS', payload);
  assert(!r.wrote, 'wrote should be false');
});

check('readSnapshot tampered JSON returns null (no throw)', () => {
  sdb.prepare(`UPDATE workstreams SET snapshot_json='NOT-JSON{' WHERE id=?`).run(
    'WS-1',
  );
  const back = readSnapshot(sdb, 'WS-1');
  assert(back === null, 'should be null');
});

check('writeManifestationPayload persists canonical JSON', () => {
  const r = writeManifestationPayload(sdb, 'WS-1', 'plan-board', {
    items: [{ id: 'a' }, { id: 'b' }],
  });
  assert(r.wrote, 'wrote=false');
  const row = sdb
    .prepare(
      `SELECT manifestation_payload, manifestation_kind FROM workstreams WHERE id=?`,
    )
    .get('WS-1') as { manifestation_payload: string; manifestation_kind: string };
  assert(row.manifestation_kind === 'plan-board', 'kind wrong');
  const parsed = JSON.parse(row.manifestation_payload);
  assert(Array.isArray(parsed.items) && parsed.items.length === 2, 'payload wrong');
});

check('writeManifestationPayload idempotency on key-reorder', () => {
  const a = writeManifestationPayload(sdb, 'WS-1', 'composer', { x: 1, y: 2 });
  const b = writeManifestationPayload(sdb, 'WS-1', 'composer', { y: 2, x: 1 });
  assert(a.wrote && !b.wrote, `a=${a.wrote} b=${b.wrote}`);
});

sdb.close();

// ─── report ─────────────────────────────────────────────────────────────
const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;
for (const c of checks) {
  const mark = c.pass ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${mark}] ${c.name}${c.detail ? `  → ${c.detail}` : ''}\n`);
}
process.stdout.write(`\n  ${passed}/${checks.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
