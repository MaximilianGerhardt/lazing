/**
 * Tests fuer server/streaming-snapshots.ts
 * ----------------------------------------
 * Streaming-Recovery V2 · Synthesis-Punkt 8.1 + 8.3.
 *
 * Was wird getestet:
 *   1. UPSERT-Pfad: mehrfaches `appendToken` + `flushFinal` resultiert in
 *      genau EINER Row pro pendingPromptId — kein doppelter INSERT.
 *   2. Code-Block-Detection: `detectInCodeBlock` reine Funktion auf Text.
 *
 * Wie:
 *   - In-Memory better-sqlite3 (`:memory:`) mit der gleichen Migration-DDL
 *     wie 0018_streaming_snapshots.sql.
 *   - `vi.mock` fuer `./db` damit `getAgentDb()` die in-memory-Instanz liefert.
 *   - Faelschlich gewollte Real-DB-Calls werden durch das Mock abgefangen.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock von ./db: liefert eine in-memory better-sqlite3-Instanz ----
let memDb: Database.Database;

vi.mock('./db', () => ({
  getAgentDb: (): Database.Database => memDb,
}));

// Wichtig: erst NACH vi.mock importieren, sonst wuerde der Original-getAgentDb
// gebunden werden.
import {
  createSnapshotWriter,
  detectInCodeBlock,
} from './streaming-snapshots';

const SNAPSHOT_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS streaming_snapshots (
    pending_prompt_id  TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    partial_content    TEXT NOT NULL DEFAULT '',
    tool_state         TEXT,
    in_code_block      INTEGER NOT NULL DEFAULT 0,
    started_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
`;

beforeEach(() => {
  memDb = new Database(':memory:');
  memDb.exec(SNAPSHOT_TABLE_DDL);
});

afterEach(() => {
  memDb?.close();
});

describe('detectInCodeBlock (pure)', () => {
  it('returns false for empty / no-fence text', () => {
    expect(detectInCodeBlock('')).toBe(false);
    expect(detectInCodeBlock('hello world')).toBe(false);
    expect(detectInCodeBlock('inline `code` only')).toBe(false);
  });

  it('returns true on a single open fence', () => {
    expect(detectInCodeBlock('here is code:\n```ts\nconst x = 1')).toBe(true);
  });

  it('returns false on a balanced (closed) fence pair', () => {
    expect(
      detectInCodeBlock('```ts\nconst x = 1;\n```\nback to prose'),
    ).toBe(false);
  });

  it('returns true on three fences (open / close / open)', () => {
    const text =
      'first block:\n```\nA\n```\nthen second open:\n```\nB still going';
    expect(detectInCodeBlock(text)).toBe(true);
  });

  it('counts only triple-backtick, not single-backtick spans', () => {
    // 4 single backticks would be 0 triples — must stay false.
    expect(detectInCodeBlock('a `x` b `y` c')).toBe(false);
  });
});

describe('createSnapshotWriter — UPSERT path', () => {
  it('upserts exactly ONE row across many appendToken+flushFinal calls', () => {
    const writer = createSnapshotWriter({
      pendingPromptId: 'pid-upsert-1',
      workspaceId: 'ws-test',
      // Hoher Intervall damit der periodic-Timer nicht in den Test-Lauf reinpfuscht.
      intervalMs: 60_000,
      now: () => 1_700_000_000_000,
    });

    writer.appendToken('Hello ');
    writer.flushFinal();
    writer.appendToken('World');
    writer.flushFinal();
    writer.appendToken('!');
    writer.flushFinal();

    const rows = memDb
      .prepare(
        `SELECT pending_prompt_id, partial_content, in_code_block,
                started_at, updated_at
           FROM streaming_snapshots`,
      )
      .all() as Array<{
        pending_prompt_id: string;
        partial_content: string;
        in_code_block: number;
        started_at: number;
        updated_at: number;
      }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].pending_prompt_id).toBe('pid-upsert-1');
    expect(rows[0].partial_content).toBe('Hello World!');
    expect(rows[0].in_code_block).toBe(0);

    writer.cancel();
  });

  it('updates partial_content + updated_at on subsequent flush, started_at stays', () => {
    let nowVal = 1_000;
    const writer = createSnapshotWriter({
      pendingPromptId: 'pid-upsert-2',
      workspaceId: 'ws-test',
      intervalMs: 60_000,
      now: () => nowVal,
    });

    writer.appendToken('one');
    writer.flushFinal();

    const row1 = memDb
      .prepare(`SELECT * FROM streaming_snapshots WHERE pending_prompt_id = ?`)
      .get('pid-upsert-2') as {
        started_at: number;
        updated_at: number;
        partial_content: string;
      };
    expect(row1.started_at).toBe(1_000);
    expect(row1.updated_at).toBe(1_000);
    expect(row1.partial_content).toBe('one');

    nowVal = 2_500;
    writer.appendToken(' two');
    writer.flushFinal();

    const row2 = memDb
      .prepare(`SELECT * FROM streaming_snapshots WHERE pending_prompt_id = ?`)
      .get('pid-upsert-2') as {
        started_at: number;
        updated_at: number;
        partial_content: string;
      };
    // started_at darf sich NICHT aendern — UPSERT setzt nur die ueberschriebenen Felder.
    expect(row2.started_at).toBe(1_000);
    // updated_at MUSS auf den neuen now-Stand gehen.
    expect(row2.updated_at).toBe(2_500);
    expect(row2.partial_content).toBe('one two');

    writer.cancel();
  });

  it('persists in_code_block=1 when partial ends inside an unclosed fence', () => {
    const writer = createSnapshotWriter({
      pendingPromptId: 'pid-codeblock',
      workspaceId: 'ws-test',
      intervalMs: 60_000,
      now: () => 1_700_000_000_000,
    });

    writer.appendToken('look:\n```ts\nconst x = 1');
    writer.flushFinal();

    const row = memDb
      .prepare(
        `SELECT in_code_block FROM streaming_snapshots WHERE pending_prompt_id = ?`,
      )
      .get('pid-codeblock') as { in_code_block: number };

    expect(row.in_code_block).toBe(1);

    // Schliesse den Block — flag muss zurueck auf 0.
    writer.appendToken(';\n```\nDone.');
    writer.flushFinal();

    const row2 = memDb
      .prepare(
        `SELECT in_code_block FROM streaming_snapshots WHERE pending_prompt_id = ?`,
      )
      .get('pid-codeblock') as { in_code_block: number };
    expect(row2.in_code_block).toBe(0);

    writer.cancel();
  });

  it('serializes tool_state as JSON and clears it back to null', () => {
    const writer = createSnapshotWriter({
      pendingPromptId: 'pid-tool',
      workspaceId: 'ws-test',
      intervalMs: 60_000,
      now: () => 1_700_000_000_000,
    });

    writer.appendToken('calling tool…');
    writer.setToolState({ name: 'Bash', status: 'pending', id: 'tu_1' });
    writer.flushFinal();

    const row1 = memDb
      .prepare(
        `SELECT tool_state FROM streaming_snapshots WHERE pending_prompt_id = ?`,
      )
      .get('pid-tool') as { tool_state: string | null };
    expect(row1.tool_state).not.toBeNull();
    const parsed = JSON.parse(row1.tool_state as string);
    expect(parsed).toMatchObject({
      name: 'Bash',
      status: 'pending',
      id: 'tu_1',
    });

    writer.clearToolState();
    writer.flushFinal();

    const row2 = memDb
      .prepare(
        `SELECT tool_state FROM streaming_snapshots WHERE pending_prompt_id = ?`,
      )
      .get('pid-tool') as { tool_state: string | null };
    expect(row2.tool_state).toBeNull();

    writer.cancel();
  });

  it('deleteRow is idempotent and removes the row', () => {
    const writer = createSnapshotWriter({
      pendingPromptId: 'pid-delete',
      workspaceId: 'ws-test',
      intervalMs: 60_000,
      now: () => 1_700_000_000_000,
    });

    writer.appendToken('partial');
    writer.flushFinal();

    expect(
      memDb
        .prepare(`SELECT COUNT(*) AS c FROM streaming_snapshots`)
        .get() as { c: number },
    ).toEqual({ c: 1 });

    writer.deleteRow();
    expect(
      memDb
        .prepare(`SELECT COUNT(*) AS c FROM streaming_snapshots`)
        .get() as { c: number },
    ).toEqual({ c: 0 });

    // Zweiter Delete muss no-op sein, kein Throw.
    expect(() => writer.deleteRow()).not.toThrow();

    writer.cancel();
  });

  it('two writers for different pendingPromptIds produce two distinct rows', () => {
    const w1 = createSnapshotWriter({
      pendingPromptId: 'pid-A',
      workspaceId: 'ws-test',
      intervalMs: 60_000,
      now: () => 1_000,
    });
    const w2 = createSnapshotWriter({
      pendingPromptId: 'pid-B',
      workspaceId: 'ws-test',
      intervalMs: 60_000,
      now: () => 2_000,
    });

    w1.appendToken('answer A');
    w1.flushFinal();
    w2.appendToken('answer B');
    w2.flushFinal();

    const rows = memDb
      .prepare(
        `SELECT pending_prompt_id, partial_content
           FROM streaming_snapshots ORDER BY pending_prompt_id ASC`,
      )
      .all() as Array<{ pending_prompt_id: string; partial_content: string }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      pending_prompt_id: 'pid-A',
      partial_content: 'answer A',
    });
    expect(rows[1]).toEqual({
      pending_prompt_id: 'pid-B',
      partial_content: 'answer B',
    });

    w1.cancel();
    w2.cancel();
  });
});
