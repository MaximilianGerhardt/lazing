/**
 * Tests für die Q/A-Pill Antwort-Routing-Logik (UX-1 · 2026-05-26).
 *
 * `routePillAnswer` ist die SINGLE-SOURCE-Logik, die sowohl der Freitext-Enter
 * im ChatShell-submit-Handler als auch der Options-Klick benutzen. Sie wird
 * pur getestet (kein ChatShell-Mount nötig), damit die Submit-Verzweigung
 * verifizierbar bleibt:
 *
 *   - ausgeklappt + Antwort auf aktuelle Frage → kein neuer Turn, nächste Frage
 *   - alle Fragen beantwortet → allAnswered=true (ChatShell feuert EINEN reply)
 *   - Options-Klick = dieselbe Logik (gleicher Pfad)
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run lib/chat/__tests__/pill-answer-routing.test.ts
 */

import { describe, expect, it } from 'vitest';

import { routePillAnswer, dedupeQuestionIds } from '../ChatOpenQuestionsPill';
import {
  parsePlanQuestions,
  type PlanQuestion,
} from '../../workstreams/parse-plan-questions';

const Q1: PlanQuestion = { id: 'q1', text: 'Markt?', options: ['DACH', 'EU'] };
const Q2: PlanQuestion = { id: 'q2', text: 'Kanal?', options: ['Email', 'Social'] };
const Q3: PlanQuestion = { id: 'q3', text: 'Budget?' };

/**
 * Spiegelt buildQAReply aus ChatShell.tsx exakt (Frage/Antwort-Block, durch
 * Leerzeile getrennt, unbeantwortete Fragen weggelassen). Module-private in
 * ChatShell → hier repliziert, um den finalen reply-Payload zu prüfen.
 */
function buildQAReply(
  questions: ReadonlyArray<{ id: string; text: string }>,
  answers: Record<string, string>,
): string {
  const lines: string[] = [];
  for (const q of questions) {
    const ans = answers[q.id];
    if (ans !== undefined) lines.push(`Frage: ${q.text}\nAntwort: ${ans}`);
  }
  return lines.join('\n\n');
}

describe('routePillAnswer — Einzelfrage', () => {
  it('eine Frage beantwortet → allAnswered=true', () => {
    const r = routePillAnswer([Q1], {}, 0, 'q1', 'DACH');
    expect(r.allAnswered).toBe(true);
    expect(r.nextAnswers).toEqual({ q1: 'DACH' });
  });
});

describe('routePillAnswer — Mehrere Fragen (Stepper-Fortschritt)', () => {
  it('erste von zwei beantworten → noch nicht alle, springt zur zweiten', () => {
    const r = routePillAnswer([Q1, Q2], {}, 0, 'q1', 'EU');
    expect(r.allAnswered).toBe(false);
    expect(r.nextIndex).toBe(1);
    expect(r.nextAnswers).toEqual({ q1: 'EU' });
  });

  it('zweite Antwort schließt das Set → allAnswered=true', () => {
    const afterFirst = routePillAnswer([Q1, Q2], {}, 0, 'q1', 'EU');
    const afterSecond = routePillAnswer(
      [Q1, Q2],
      afterFirst.nextAnswers,
      afterFirst.nextIndex,
      'q2',
      'Email',
    );
    expect(afterSecond.allAnswered).toBe(true);
    expect(afterSecond.nextAnswers).toEqual({ q1: 'EU', q2: 'Email' });
  });

  it('springt über bereits beantwortete Fragen zur nächsten offenen', () => {
    // q1 schon beantwortet; jetzt q2 beantworten → q3 ist als nächstes offen.
    const r = routePillAnswer([Q1, Q2, Q3], { q1: 'DACH' }, 1, 'q2', 'Social');
    expect(r.allAnswered).toBe(false);
    expect(r.nextIndex).toBe(2);
  });

  it('wrap-around: letzte Frage beantwortet, vorne noch offen → Index 0', () => {
    // q2, q3 beantwortet, jetzt q-am-Index-2 (q3) erneut; q1 noch offen → wrap.
    const r = routePillAnswer([Q1, Q2, Q3], { q2: 'Email', q3: 'X' }, 2, 'q3', 'Y');
    expect(r.allAnswered).toBe(false);
    expect(r.nextIndex).toBe(0);
  });
});

describe('routePillAnswer — Options-Klick = Freitext-Logik (gleicher Pfad)', () => {
  it('Options-Wert wird identisch wie Freitext gesetzt', () => {
    const viaOption = routePillAnswer([Q1, Q2], {}, 0, 'q1', 'DACH');
    const viaText = routePillAnswer([Q1, Q2], {}, 0, 'q1', 'DACH');
    expect(viaOption).toEqual(viaText);
  });

  it('Klick auf NICHT-aktuelle Frage nutzt deren Index als Startpunkt', () => {
    // currentIndex=0, aber Klick zielt auf q2 (Index 1) → nächste offene ab 1.
    const r = routePillAnswer([Q1, Q2, Q3], {}, 0, 'q2', 'Social');
    expect(r.nextAnswers).toEqual({ q2: 'Social' });
    // ab Index 1 vorwärts: q3 (Index 2) ist offen.
    expect(r.nextIndex).toBe(2);
  });
});

describe('routePillAnswer — Idempotenz / Überschreiben', () => {
  it('erneute Antwort auf dieselbe Frage überschreibt den Wert', () => {
    const r = routePillAnswer([Q1, Q2], { q1: 'DACH' }, 0, 'q1', 'EU');
    expect(r.nextAnswers.q1).toBe('EU');
    expect(r.allAnswered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MAJOR 3a — Duplikat-Fragetexte → kollidierende Hash-IDs (2026-05-26)
// ---------------------------------------------------------------------------

describe('dedupeQuestionIds — kollidierende Hash-IDs (MAJOR 3a)', () => {
  it('parsePlanQuestions kollidiert bei textgleichen Fragen (Repro)', () => {
    // Beweis der Wurzel: identischer Text → identische hashString-ID.
    const md = [
      '## Offene Fragen',
      '- Welches Budget? | OPTIONS: Klein | Groß',
      '- Welches Budget? | OPTIONS: Klein | Groß',
    ].join('\n');
    const raw = parsePlanQuestions(md);
    expect(raw).toHaveLength(2);
    // Vor dem Dedup: beide IDs identisch (das ist der Bug).
    expect(raw[0]!.id).toBe(raw[1]!.id);
  });

  it('dedupeQuestionIds vergibt der Wiederholung ein -n-Suffix', () => {
    const md = [
      '## Offene Fragen',
      '- Welches Budget? | OPTIONS: Klein | Groß',
      '- Welches Budget? | OPTIONS: Klein | Groß',
    ].join('\n');
    const unique = dedupeQuestionIds(parsePlanQuestions(md));
    expect(unique).toHaveLength(2);
    expect(unique[0]!.id).not.toBe(unique[1]!.id);
    expect(unique[1]!.id).toBe(`${unique[0]!.id}-1`);
    // Text bleibt unverändert (nur die ID wird dedupt).
    expect(unique[0]!.text).toBe(unique[1]!.text);
  });

  it('drei textgleiche Fragen → IDs base, base-1, base-2', () => {
    const md = [
      '## Offene Fragen',
      '- Region?',
      '- Region?',
      '- Region?',
    ].join('\n');
    const unique = dedupeQuestionIds(parsePlanQuestions(md));
    expect(unique).toHaveLength(3);
    const ids = unique.map((q) => q.id);
    expect(new Set(ids).size).toBe(3); // alle distinct
    expect(ids[1]).toBe(`${ids[0]}-1`);
    expect(ids[2]).toBe(`${ids[0]}-2`);
  });

  it('zwei textgleiche Fragen sind separat beantwortbar; allAnswered erst nach beiden; EIN reply mit beiden Antworten', () => {
    const md = [
      '## Offene Fragen',
      '- Welches Budget? | OPTIONS: Klein | Groß',
      '- Welches Budget? | OPTIONS: Klein | Groß',
    ].join('\n');
    const questions = dedupeQuestionIds(parsePlanQuestions(md));
    expect(questions).toHaveLength(2);

    // Frage 1 (Index 0) beantworten → NICHT allAnswered (Bug-Symptom wäre:
    // allAnswered true nach einer Antwort wegen kollidierender ID).
    const first = routePillAnswer(questions, {}, 0, questions[0]!.id, 'Klein');
    expect(first.allAnswered).toBe(false);
    expect(first.nextIndex).toBe(1); // springt NICHT auf Index 0 zurück (Stuck)

    // Frage 2 (Index 1) beantworten → jetzt allAnswered.
    const second = routePillAnswer(
      questions,
      first.nextAnswers,
      first.nextIndex,
      questions[1]!.id,
      'Groß',
    );
    expect(second.allAnswered).toBe(true);

    // Beide Antworten getrennt gespeichert (nicht überschrieben).
    expect(second.nextAnswers[questions[0]!.id]).toBe('Klein');
    expect(second.nextAnswers[questions[1]!.id]).toBe('Groß');

    // EIN finaler reply-Payload enthält BEIDE Antworten (Klein + Groß).
    const payload = buildQAReply(questions, second.nextAnswers);
    expect(payload).toContain('Klein');
    expect(payload).toContain('Groß');
    // Genau zwei Q&A-Blöcke (durch Leerzeile getrennt) — keine doppelte Antwort.
    expect(payload.split('\n\n')).toHaveLength(2);
  });

  it('Options-Klick auf zweite textgleiche Bubble nutzt deren Index (kein Navigations-Stuck)', () => {
    const md = ['## Offene Fragen', '- Region?', '- Region?'].join('\n');
    const questions = dedupeQuestionIds(parsePlanQuestions(md));
    // Klick auf die ZWEITE Bubble (Index 1) bei currentIndex 0 → findIndex
    // muss die zweite ID auflösen (vor dem Fix sprang er auf Index 0).
    const r = routePillAnswer(questions, {}, 0, questions[1]!.id, 'EU');
    expect(r.nextAnswers[questions[1]!.id]).toBe('EU');
    expect(r.nextAnswers[questions[0]!.id]).toBeUndefined();
    // Noch offen: die erste Bubble (Index 0) → wrap-around dorthin.
    expect(r.allAnswered).toBe(false);
    expect(r.nextIndex).toBe(0);
  });
});
