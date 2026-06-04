/**
 * Migration 0117 (question_answers) — In-Memory-Smoke-Test · 2026-05-29.
 *
 * Phase 1 Track AB · Befund B.
 *
 * Stellt sicher dass:
 *   1. Die Migration sauber gegen eine leere :memory:-DB exec'd werden kann.
 *   2. Die Tabelle + Spalten + Indizes existieren wie spezifiziert.
 *   3. INSERT mit Pflicht-Feldern funktioniert.
 *   4. Optional-Felder dürfen NULL sein.
 *   5. UNIQUE-Constraints (content_hash · source_turn_id+question_id) greifen.
 *   6. Migration ist idempotent (zweiter exec wirft NICHT).
 *
 * Run:
 *   NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *     db/migrations/__tests__/0117_question_answers.test.ts
 */

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '..',
  '0117_question_answers.sql',
);

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  return db;
}

describe('Migration 0117 — question_answers schema', () => {
  it('Tabelle existiert mit allen Pflicht-Spalten', () => {
    const db = freshDb();
    const cols = db
      .prepare(`PRAGMA table_info(question_answers)`)
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.has('id')).toBe(true);
    expect(byName.has('workspace_id')).toBe(true);
    expect(byName.has('workstream_id')).toBe(true);
    expect(byName.has('flow_run_id')).toBe(true);
    expect(byName.has('plan_id')).toBe(true);
    expect(byName.has('question_set_id')).toBe(true);
    expect(byName.has('question_id')).toBe(true);
    expect(byName.has('answer')).toBe(true);
    expect(byName.has('source_turn_id')).toBe(true);
    expect(byName.has('surface_id')).toBe(true);
    expect(byName.has('created_at')).toBe(true);
    expect(byName.has('content_hash')).toBe(true);

    // id ist PK
    expect(byName.get('id')!.pk).toBe(1);
    // notnull-Constraints auf Pflicht-Feldern
    expect(byName.get('workspace_id')!.notnull).toBe(1);
    expect(byName.get('question_id')!.notnull).toBe(1);
    expect(byName.get('answer')!.notnull).toBe(1);
    expect(byName.get('source_turn_id')!.notnull).toBe(1);
    expect(byName.get('content_hash')!.notnull).toBe(1);
    expect(byName.get('created_at')!.notnull).toBe(1);
    // Optionale Felder DÜRFEN NULL sein.
    expect(byName.get('workstream_id')!.notnull).toBe(0);
    expect(byName.get('flow_run_id')!.notnull).toBe(0);
    expect(byName.get('plan_id')!.notnull).toBe(0);
    expect(byName.get('question_set_id')!.notnull).toBe(0);
    expect(byName.get('surface_id')!.notnull).toBe(0);
  });

  it('Indizes existieren (workspace+workstream, question_id, UNIQUE(content_hash), UNIQUE(turn,question))', () => {
    const db = freshDb();
    const indexes = db
      .prepare(`SELECT name, "unique" AS uq FROM pragma_index_list('question_answers')`)
      .all() as Array<{ name: string; uq: number }>;
    const byName = new Map(indexes.map((i) => [i.name, i]));
    expect(byName.has('idx_question_answers_ws_workstream')).toBe(true);
    expect(byName.has('idx_question_answers_question_id')).toBe(true);
    expect(byName.has('uniq_question_answers_content_hash')).toBe(true);
    expect(byName.has('uniq_question_answers_turn_question')).toBe(true);
    expect(byName.get('uniq_question_answers_content_hash')!.uq).toBe(1);
    expect(byName.get('uniq_question_answers_turn_question')!.uq).toBe(1);
  });

  it('INSERT mit Pflicht-Feldern funktioniert', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO question_answers
         (id, workspace_id, question_id, answer, source_turn_id, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('qa1', 'ws-1', 'q-1', 'meine antwort', 'turn-1', 'hash-a');
    const row = db
      .prepare(`SELECT * FROM question_answers WHERE id = ?`)
      .get('qa1') as {
        workstream_id: string | null;
        flow_run_id: string | null;
        plan_id: string | null;
        question_set_id: string | null;
        surface_id: string | null;
        answer: string;
        created_at: number;
      };
    expect(row.answer).toBe('meine antwort');
    expect(row.workstream_id).toBeNull();
    expect(row.flow_run_id).toBeNull();
    expect(row.plan_id).toBeNull();
    expect(row.question_set_id).toBeNull();
    expect(row.surface_id).toBeNull();
    // created_at hat Default 0.
    expect(row.created_at).toBe(0);
  });

  it('UNIQUE(content_hash) — zweiter INSERT mit gleichem Hash wirft', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO question_answers
         (id, workspace_id, question_id, answer, source_turn_id, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('qa1', 'ws-1', 'q-1', 'a', 'turn-1', 'samehash');
    expect(() =>
      db
        .prepare(
          `INSERT INTO question_answers
             (id, workspace_id, question_id, answer, source_turn_id, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('qa2', 'ws-1', 'q-2', 'b', 'turn-2', 'samehash'),
    ).toThrow(/UNIQUE constraint failed.*content_hash/);
  });

  it('UNIQUE(source_turn_id, question_id) — zweiter INSERT mit gleichem Tupel wirft', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO question_answers
         (id, workspace_id, question_id, answer, source_turn_id, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('qa1', 'ws-1', 'q-1', 'a', 'turn-anker', 'hash-a');
    expect(() =>
      db
        .prepare(
          `INSERT INTO question_answers
             (id, workspace_id, question_id, answer, source_turn_id, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('qa2', 'ws-1', 'q-1', 'b', 'turn-anker', 'hash-b'),
    ).toThrow(/UNIQUE constraint failed.*(source_turn_id|question_id)/);
  });

  it('INSERT OR IGNORE schluckt UNIQUE-Konflikt still (changes=0)', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO question_answers
         (id, workspace_id, question_id, answer, source_turn_id, content_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('qa1', 'ws-1', 'q-1', 'a', 't-1', 'h-1');
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO question_answers
           (id, workspace_id, question_id, answer, source_turn_id, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('qa2', 'ws-1', 'q-1', 'a', 't-1', 'h-1');
    expect(r.changes).toBe(0);
    const count = db
      .prepare(`SELECT COUNT(*) as c FROM question_answers`)
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('Migration idempotent — zweiter exec wirft nicht (IF NOT EXISTS)', () => {
    const db = freshDb();
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(() => db.exec(sql)).not.toThrow();
  });
});
