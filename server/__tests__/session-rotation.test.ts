// session-rotation — testet rotateSessionWithHandoff über injizierte Deps gegen
// eine in-memory better-sqlite3 (echte Migrationen). Kern-Invariante (Audit):
// FAIL-CLOSED-Ordering — ein Persist-Wurf ⇒ KEINE Rotation, die UUID bleibt.
//
// Run: NODE_OPTIONS=--experimental-require-module vitest run server/__tests__/session-rotation.test.ts

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { rotateSessionWithHandoff } from '@/server/workspace-session';

const MIG = (n: string): string => path.join(process.cwd(), 'db', 'migrations', n);

function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  // workspaces (FK-Ziel von claude_sessions) + claude_sessions (0006) + 0127-Spalten.
  raw.exec(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, notes TEXT, notes_updated_at INTEGER, notes_source TEXT);`);
  raw.exec(readFileSync(MIG('0006_claude_sessions.sql'), 'utf8'));
  raw.exec(readFileSync(MIG('0127_session_rotation.sql'), 'utf8'));
  return raw;
}

const WS = 'wsp-rot';
function seedSession(raw: import('better-sqlite3').Database, sessionId: string, turnCount = 30): void {
  raw.prepare(`INSERT INTO workspaces (id) VALUES (?)`).run(WS);
  raw
    .prepare(
      `INSERT INTO claude_sessions (workspace_id, session_id, last_prompt_at, turn_count, token_estimate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(WS, sessionId, 1000, turnCount, 5000, 1000, 1000);
}

function readSession(raw: import('better-sqlite3').Database): {
  session_id: string;
  prev_session_id: string | null;
  turn_count: number;
  token_estimate: number;
  rotation_count: number;
  rotation_reason: string | null;
} {
  return raw.prepare('SELECT * FROM claude_sessions WHERE workspace_id = ?').get(WS) as never;
}

describe('rotateSessionWithHandoff — happy path', () => {
  let raw: import('better-sqlite3').Database;
  beforeEach(() => {
    raw = freshDb();
    seedSession(raw, 'OLD-UUID', 30);
  });

  it('persists handoff THEN rotates to a fresh UUID with bookkeeping', () => {
    let persistCalledBeforeUpdate = false;
    const r = rotateSessionWithHandoff(WS, 'turn-budget', {
      db: raw,
      persist: (_d, _ws) => {
        // Beim Persist darf die UUID noch NICHT rotiert sein (Ordering-Beweis).
        persistCalledBeforeUpdate = readSession(raw).session_id === 'OLD-UUID';
        return { written: true };
      },
      newId: () => 'NEW-UUID',
      now: () => 42,
    });

    expect(r.rotated).toBe(true);
    expect(r.reason).toBe('turn-budget');
    expect(r.newSessionId).toBe('NEW-UUID');
    expect(persistCalledBeforeUpdate).toBe(true);

    const s = readSession(raw);
    expect(s.session_id).toBe('NEW-UUID');
    expect(s.prev_session_id).toBe('OLD-UUID');
    expect(s.turn_count).toBe(0);
    expect(s.token_estimate).toBe(0);
    expect(s.rotation_count).toBe(1);
    expect(s.rotation_reason).toBe('turn-budget');
  });

  it('an empty-handoff persist (written=false) still rotates (nothing to lose)', () => {
    const r = rotateSessionWithHandoff(WS, 'age-budget', {
      db: raw,
      persist: () => ({ written: false }),
      newId: () => 'NEW2',
    });
    expect(r.rotated).toBe(true);
    expect(r.handoffWritten).toBe(false);
    expect(readSession(raw).session_id).toBe('NEW2');
  });
});

describe('rotateSessionWithHandoff — FAIL-CLOSED (the critical invariant)', () => {
  let raw: import('better-sqlite3').Database;
  beforeEach(() => {
    raw = freshDb();
    seedSession(raw, 'OLD-UUID', 30);
  });

  it('a persist THROW ⇒ NO rotation, UUID + counts UNCHANGED', () => {
    const r = rotateSessionWithHandoff(WS, 'token-budget', {
      db: raw,
      persist: () => {
        throw new Error('DB down');
      },
      newId: () => 'SHOULD-NOT-APPEAR',
    });
    expect(r.rotated).toBe(false);
    expect(r.reason).toBe('handoff-persist-failed');
    const s = readSession(raw);
    expect(s.session_id).toBe('OLD-UUID'); // unverändert
    expect(s.turn_count).toBe(30); // nicht zurückgesetzt
    expect(s.rotation_count).toBe(0);
  });

  it('no session row ⇒ no rotation', () => {
    const empty = freshDb(); // kein seedSession
    const r = rotateSessionWithHandoff(WS, 'turn-budget', { db: empty, persist: () => ({ written: true }) });
    expect(r.rotated).toBe(false);
  });

  it('MED-2 concurrency: a rotation that loses the race (session_id changed during persist) NO-OPs, does not clobber', () => {
    const r = rotateSessionWithHandoff(WS, 'turn-budget', {
      db: raw,
      persist: () => {
        // Simuliere: ein konkurrierender Request rotiert ZUERST (zwischen unserem
        // prev-Read und unserem UPDATE). Unser UPDATE WHERE session_id='OLD-UUID'
        // trifft dann 0 Zeilen → wir rotieren NICHT (kein UUID-Clobber).
        raw.prepare('UPDATE claude_sessions SET session_id=? WHERE workspace_id=?').run('WON-BY-OTHER', WS);
        return { written: true };
      },
      newId: () => 'MINE',
    });
    expect(r.rotated).toBe(false);
    expect(readSession(raw).session_id).toBe('WON-BY-OTHER'); // nicht zu MINE überschrieben
  });
});
