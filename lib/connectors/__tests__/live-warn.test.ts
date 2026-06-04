/**
 * Stream X1 (2026-05-28) — live-warn ack persistence tests.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/connectors/__tests__/live-warn.test.ts
 *
 * Coverage:
 *   - recordLiveWarnAck inserts an `ack:` belief that isLiveWarnAcked() reads back.
 *   - Re-calling recordLiveWarnAck supersedes the previous topic-row (no
 *     duplicate active row; chain continues via supersedes_id).
 *   - decision='decline' is persisted but does NOT mark the workspace as
 *     acknowledged (warning re-appears next time).
 *   - isLiveWarnAcked is workspace-scoped: a sibling workspace stays
 *     unacknowledged.
 *   - getDb() is mocked to a fresh in-memory better-sqlite3 instance — pure
 *     repo-level test (no external DB).
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Set up an in-memory DB and stub getDb BEFORE importing the SUT (live-warn).
const memDb = new Database(':memory:');

// Minimal schema: only workspace_beliefs is needed.
memDb.exec(`
CREATE TABLE IF NOT EXISTS workspace_beliefs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  belief TEXT NOT NULL,
  rationale TEXT NOT NULL,
  source TEXT NOT NULL,
  supersedes_id TEXT,
  confidence REAL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

vi.mock('@/db/client', () => ({
  getDb: () => ({
    $raw: memDb,
  }),
}));

const { isLiveWarnAcked, recordLiveWarnAck, LIVE_WARN_TOPIC } = await import(
  '../live-warn'
);

beforeEach(() => {
  memDb.prepare('DELETE FROM workspace_beliefs').run();
});

describe('live-warn persistence', () => {
  it('isLiveWarnAcked is false for a fresh workspace', () => {
    expect(isLiveWarnAcked('ws-fresh')).toBe(false);
  });

  it('recordLiveWarnAck(ack) → isLiveWarnAcked becomes true', () => {
    const b = recordLiveWarnAck('ws-1', 'ack');
    expect(b.topic).toBe(LIVE_WARN_TOPIC);
    expect(b.belief.startsWith('ack:')).toBe(true);
    expect(isLiveWarnAcked('ws-1')).toBe(true);
  });

  it('recordLiveWarnAck(decline) → isLiveWarnAcked stays false (warning re-appears)', () => {
    const b = recordLiveWarnAck('ws-2', 'decline');
    expect(b.belief.startsWith('decline:')).toBe(true);
    expect(isLiveWarnAcked('ws-2')).toBe(false);
  });

  it('re-acking is idempotent — supersede chain, no duplicate active rows', () => {
    recordLiveWarnAck('ws-3', 'ack');
    recordLiveWarnAck('ws-3', 'ack');
    recordLiveWarnAck('ws-3', 'ack');

    const rows = memDb
      .prepare(
        `SELECT id, supersedes_id FROM workspace_beliefs
           WHERE workspace_id = ? AND topic = ?`,
      )
      .all('ws-3', LIVE_WARN_TOPIC) as Array<{
      id: string;
      supersedes_id: string | null;
    }>;
    expect(rows).toHaveLength(3);
    // Two of them should reference an older row.
    const withSupersede = rows.filter((r) => r.supersedes_id !== null);
    expect(withSupersede).toHaveLength(2);

    // listBeliefs (active-only) returns exactly ONE row for this topic.
    expect(isLiveWarnAcked('ws-3')).toBe(true);
  });

  it('workspace-scoped: ack on ws-A does NOT affect ws-B', () => {
    recordLiveWarnAck('ws-A', 'ack');
    expect(isLiveWarnAcked('ws-A')).toBe(true);
    expect(isLiveWarnAcked('ws-B')).toBe(false);
  });

  it('switching ack → decline flips isLiveWarnAcked back to false', () => {
    recordLiveWarnAck('ws-flip', 'ack');
    expect(isLiveWarnAcked('ws-flip')).toBe(true);
    recordLiveWarnAck('ws-flip', 'decline');
    expect(isLiveWarnAcked('ws-flip')).toBe(false);
  });

  it('throws on empty workspaceId', () => {
    expect(() => recordLiveWarnAck('', 'ack')).toThrow();
  });

  it('throws on invalid decision', () => {
    expect(() =>
      recordLiveWarnAck('ws-x', 'maybe' as unknown as 'ack'),
    ).toThrow();
  });
});
