/**
 * lib/subchats/__tests__/questions-service.test.ts — Question-Spinning Slice 1.
 *
 * Nutzt die ECHTE db/client (volle Migrationskette inkl. 0128) auf einer
 * temporären Datei-DB. WICHTIG: LAZYOS_DB_PATH muss VOR dem ersten Import von
 * db/client gesetzt sein (DB_PATH wird beim Modul-Load berechnet) → daher
 * dynamische Imports nach dem env-Set.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run \
 *     lib/subchats/__tests__/questions-service.test.ts
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'scq-test-'));
process.env.LAZYOS_DB_PATH = path.join(dir, 'test.db');
process.env.LAZYOS_TEST_DISABLE_FK = '1';

const {
  spinQuestion,
  answerQuestion,
  listOpenQuestions,
  listQuestionViews,
  resolveQuestion,
  formatSubchatQuestionsContextBlock,
} = await import('@/lib/subchats/questions-service');

const WS = 'ws-test';
const SC = 'SC-test1';

describe('questions-service', () => {
  it('spinnt eine Frage mit Optionen an; listOpenQuestions liefert sie in seq-Reihenfolge', () => {
    const a = spinQuestion({
      subchatId: SC,
      workspaceId: WS,
      authorKind: 'internal',
      authorId: 'u1',
      authorName: 'Team',
      text: 'Welche Farbe für das Logo?',
      options: ['Rot', 'Grün', 'Blau'],
    });
    expect(a.question.text).toBe('Welche Farbe für das Logo?');
    expect(a.question.seq).toBe(1);
    expect(a.options.map((o) => o.label)).toEqual(['Rot', 'Grün', 'Blau']);

    const b = spinQuestion({
      subchatId: SC,
      workspaceId: WS,
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Deadline?',
    });
    expect(b.question.seq).toBe(2); // monoton „aufeinanderfolgend"

    const open = listOpenQuestions(SC);
    expect(open.map((o) => o.question.text)).toEqual([
      'Welche Farbe für das Logo?',
      'Deadline?',
    ]);
  });

  it('answerQuestion per Option UND per Freitext legt je eine Answer-Row an (append-only)', () => {
    const q = spinQuestion({
      subchatId: 'SC-ans',
      workspaceId: WS,
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Format?',
      options: ['Reel', 'TikTok'],
    });
    const optId = q.options[0]!.id;
    answerQuestion({
      questionId: q.question.id,
      subchatId: 'SC-ans',
      workspaceId: WS,
      answererKind: 'internal',
      answererId: 'u2',
      answererName: 'Anna',
      optionId: optId,
    });
    answerQuestion({
      questionId: q.question.id,
      subchatId: 'SC-ans',
      workspaceId: WS,
      answererKind: 'internal',
      answererId: 'u3',
      answererName: 'Ben',
      freeText: 'Beides bitte',
    });
    const view = listQuestionViews('SC-ans').find((v) => v.question.id === q.question.id)!;
    expect(view.answers.length).toBe(2);
    expect(view.answers[0]!.optionId).toBe(optId);
    expect(view.answers[1]!.freeText).toBe('Beides bitte');
  });

  it('resolveQuestion entfernt die Frage aus den offenen', () => {
    const q = spinQuestion({
      subchatId: 'SC-res',
      workspaceId: WS,
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Schon erledigt?',
    });
    expect(listOpenQuestions('SC-res').length).toBe(1);
    resolveQuestion(q.question.id, 'u1');
    expect(listOpenQuestions('SC-res').length).toBe(0);
  });

  it('formatSubchatQuestionsContextBlock zeigt offene + beantwortete Fragen (Hauptchat-Awareness)', () => {
    const ws2 = 'ws-ctx';
    const q1 = spinQuestion({
      subchatId: 'SC-ctx',
      workspaceId: ws2,
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Noch offen hier?',
    });
    const q2 = spinQuestion({
      subchatId: 'SC-ctx',
      workspaceId: ws2,
      authorKind: 'internal',
      authorId: 'u1',
      text: 'Budget freigegeben?',
      options: ['Ja', 'Nein'],
    });
    answerQuestion({
      questionId: q2.question.id,
      subchatId: 'SC-ctx',
      workspaceId: ws2,
      answererKind: 'internal',
      answererId: 'u2',
      optionId: q2.options[0]!.id, // 'Ja'
    });
    resolveQuestion(q2.question.id, 'u2');

    const block = formatSubchatQuestionsContextBlock(ws2);
    expect(block).toBeTruthy();
    expect(block).toContain('Noch offen hier?'); // offene Frage
    expect(block).toContain('Budget freigegeben?'); // beantwortete Frage
    expect(block).toContain('Ja'); // die gewählte Option als Antwort
    // q1 bleibt offen:
    void q1;
  });
});
