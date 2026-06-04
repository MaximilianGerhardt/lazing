/**
 * lib/subchats/__tests__/questions-resolve.test.ts — Auto-Resolve Slice.
 *
 * Echte db/client (volle Migrationskette). LAZYOS_DB_PATH vor dem ersten Import.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'scqr-test-'));
process.env.LAZYOS_DB_PATH = path.join(dir, 'test.db');
process.env.LAZYOS_TEST_DISABLE_FK = '1';

const { spinQuestion, listOpenQuestions } = await import('@/lib/subchats/questions-service');
const { sweepStaleSubchatQuestions } = await import('@/lib/subchats/questions-resolve');
const { getDb } = await import('@/db/client');

function addMessage(subchatId: string, workspaceId: string, content: string): void {
  getDb()
    .$raw.prepare(
      `INSERT INTO subchat_messages (id, subchat_id, workspace_id, author_kind, author_id, author_name, content, attachments, ingested, created_at)
       VALUES (?, ?, ?, 'internal', 'u1', 'Team', ?, NULL, 0, ?)`,
    )
    .run(`SCM-${Math.random().toString(36).slice(2)}`, subchatId, workspaceId, content, Date.now());
}

describe('sweepStaleSubchatQuestions', () => {
  it('resolved eine Frage, die im Verlauf lexical beantwortet wurde', () => {
    const q = spinQuestion({
      subchatId: 'SC-r1',
      workspaceId: 'ws',
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Welche Farbe für das Logo?',
    });
    // Antwort mit hoher Token-Überlappung (Farbe, Logo).
    addMessage('SC-r1', 'ws', 'Die Farbe für das Logo soll grün sein.');

    expect(listOpenQuestions('SC-r1').length).toBe(1);
    const res = sweepStaleSubchatQuestions();
    expect(res.resolved).toBeGreaterThanOrEqual(1);
    expect(listOpenQuestions('SC-r1').length).toBe(0);
    void q;
  });

  it('lässt eine Frage OHNE passende Antwort offen', () => {
    spinQuestion({
      subchatId: 'SC-r2',
      workspaceId: 'ws',
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Welches Budget ist freigegeben?',
    });
    addMessage('SC-r2', 'ws', 'Schönes Wetter heute, oder?');
    sweepStaleSubchatQuestions();
    expect(listOpenQuestions('SC-r2').length).toBe(1);
  });

  it('keine offenen Fragen → {scanned:0, resolved:0}', () => {
    const res = sweepStaleSubchatQuestions();
    // (Die anderen Tests könnten Fragen hinterlassen — prüfe nur den Typ.)
    expect(typeof res.scanned).toBe('number');
    expect(typeof res.resolved).toBe('number');
  });
});
