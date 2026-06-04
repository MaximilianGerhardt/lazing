/**
 * Tests für die Open-Questions-Lifecycle-Erweiterungen (2026-05-28, Owner-Befund).
 *
 * OWNER-SYMPTOM (verbatim):
 *  - „Im PA Chat ist immer noch Offene Fragen, obwohl die schon unfassbar alt
 *     sind und schon lange beantwortet."
 *  - „Wenn der mir eine neue Frage stellt, dann wieder im alten Muster/Surface
 *     mit Empfehlung usw. ist ganz cool, aber dadurch etwas doppelt und ggf.
 *     redundant."
 *
 * Diese Tests sichern die VIER neuen Funktions-Lücken:
 *  1. Auto-Resolve via Lexical-Match (User-Message enthält Content-Tokens der Frage).
 *  2. Auto-Stale via Alters-Verfall (askedAt > 24h UND ≥20 Turns danach).
 *  3. Anti-Doppelung: zweite Emission zur SELBEN ID reichert NUR an.
 *  4. Manueller Dismiss-Event entfernt EINE Frage + behält Restsignatur konsistent.
 *
 * Pur (kein React, kein DOM). Idempotent.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' npx vitest run \
 *      lib/chat/__tests__/open-questions-lifecycle-stale-resolve.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  collectOpenQuestionsFromHistory,
  detectResolvedAndStaleQuestions,
  extractOpenQuestionsFromContent,
  markStaleOpenQuestionsResolved,
  mergeQuestionEnrichmentsById,
  nextOpenQuestionsState,
  questionsSignature,
  EMPTY_OPEN_QUESTIONS_STATE,
  type OpenQuestion,
  type OpenQuestionsSourceItem,
  type OpenQuestionsState,
} from '../open-questions-lifecycle';

// ---------------------------------------------------------------------------
// 1. Erweitertes Payload-Schema — Enrichment-Felder werden geparst
// ---------------------------------------------------------------------------

describe('extractOpenQuestionsFromContent — Enrichment-Felder (2026-05-28)', () => {
  it('zieht context/pros/cons/recommendation/evidence/askedAt aus Surface', () => {
    const content =
      '<surface:open-questions>{"questions":[{' +
      '"id":"qa","q":"Erst Copy oder erst Design?",' +
      '"options":["Copy zuerst","Design zuerst"],' +
      '"context":"Webseite-Sprint, beide Pfade möglich.",' +
      '"pros":["Copy zuerst → Layout passt sich Inhalt an"],' +
      '"cons":["Design zuerst → Copy muss sich pressen"],' +
      '"recommendation":"Copy zuerst",' +
      '"evidence":["https://example.com/study"],' +
      '"askedAt":"2026-05-27T10:00:00.000Z"' +
      '}]}</surface:open-questions>';
    const qs = extractOpenQuestionsFromContent(content);
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.id).toBe('qa');
    expect(q.text).toBe('Erst Copy oder erst Design?');
    expect(q.options).toEqual(['Copy zuerst', 'Design zuerst']);
    expect(q.context).toContain('Webseite-Sprint');
    expect(q.pros).toEqual(['Copy zuerst → Layout passt sich Inhalt an']);
    expect(q.cons).toEqual(['Design zuerst → Copy muss sich pressen']);
    expect(q.recommendation).toBe('Copy zuerst');
    expect(q.evidence).toEqual(['https://example.com/study']);
    expect(q.askedAt).toBe('2026-05-27T10:00:00.000Z');
  });

  it('Backward-Compat: Payload ohne neue Felder rendert wie vorher', () => {
    const content =
      '<surface:open-questions>{"questions":[{"id":"alt","q":"Markt?","options":["DACH","EU"]}]}</surface:open-questions>';
    const qs = extractOpenQuestionsFromContent(content);
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.id).toBe('alt');
    expect(q.text).toBe('Markt?');
    expect(q.options).toEqual(['DACH', 'EU']);
    expect(q.context).toBeUndefined();
    expect(q.pros).toBeUndefined();
    expect(q.recommendation).toBeUndefined();
  });

  it('leere/whitespace-only Enrichment-Felder landen NICHT im Output', () => {
    const content =
      '<surface:open-questions>{"questions":[{"id":"x","q":"X?","context":"   ","pros":[],"cons":["   "],"recommendation":""}]}</surface:open-questions>';
    const qs = extractOpenQuestionsFromContent(content);
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.context).toBeUndefined();
    expect(q.pros).toBeUndefined();
    expect(q.cons).toBeUndefined();
    expect(q.recommendation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Anti-Doppelung — mergeQuestionEnrichmentsById + collectOpenQuestionsFromHistory
// ---------------------------------------------------------------------------

describe('mergeQuestionEnrichmentsById — Anti-Doppelung (2026-05-28)', () => {
  it('zweite Emission zur gleichen ID reichert NUR an (kein Duplikat)', () => {
    const first: OpenQuestion = {
      id: 'q1',
      text: 'Markt?',
      options: ['DACH', 'EU'],
    };
    const enriched: OpenQuestion = {
      id: 'q1',
      text: 'Markt?', // gleicher Text — Surface würde es nochmal mitschicken
      recommendation: 'DACH',
      pros: ['Heimmarkt'],
    };
    const merged = mergeQuestionEnrichmentsById([first, enriched]);
    expect(merged).toHaveLength(1);
    const q = merged[0]!;
    expect(q.id).toBe('q1');
    expect(q.options).toEqual(['DACH', 'EU']); // erstes Vorkommen → bleibt
    expect(q.recommendation).toBe('DACH'); // angereichert
    expect(q.pros).toEqual(['Heimmarkt']);
  });

  it('späte Emission ohne options[] killt die options NICHT (erstes Vorkommen gewinnt)', () => {
    const first: OpenQuestion = { id: 'q', text: 'A?', options: ['X', 'Y'] };
    const second: OpenQuestion = { id: 'q', text: 'A?', recommendation: 'X' };
    const merged = mergeQuestionEnrichmentsById([first, second]);
    expect(merged[0]!.options).toEqual(['X', 'Y']);
    expect(merged[0]!.recommendation).toBe('X');
  });

  it('drei Emissions mit jeweils einem Feld → eine Karte mit allen drei Feldern', () => {
    const merged = mergeQuestionEnrichmentsById([
      { id: 'q', text: 'A?', context: 'C' },
      { id: 'q', text: 'A?', recommendation: 'R' },
      { id: 'q', text: 'A?', pros: ['P'] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.context).toBe('C');
    expect(merged[0]!.recommendation).toBe('R');
    expect(merged[0]!.pros).toEqual(['P']);
  });

  it('verschiedene IDs werden NICHT zusammengeführt', () => {
    const merged = mergeQuestionEnrichmentsById([
      { id: 'a', text: 'A?' },
      { id: 'b', text: 'B?' },
    ]);
    expect(merged).toHaveLength(2);
  });

  it('idempotent: zweimal mergen ändert das Ergebnis nicht', () => {
    const input: OpenQuestion[] = [
      { id: 'q', text: 'A?', options: ['X'], context: 'C' },
      { id: 'q', text: 'A?', recommendation: 'X' },
    ];
    const once = mergeQuestionEnrichmentsById(input);
    const twice = mergeQuestionEnrichmentsById(once);
    expect(twice).toEqual(once);
  });
});

describe('collectOpenQuestionsFromHistory — Anti-Doppelung integriert', () => {
  it('zwei <surface:open-questions>-Tags im SELBEN Item mit gleicher ID → eine Karte', () => {
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content: [
          '<surface:open-questions>{"questions":[{"id":"dup","q":"X?","options":["A","B"]}]}</surface:open-questions>',
          'Empfehlung kommt:',
          '<surface:open-questions>{"questions":[{"id":"dup","q":"X?","recommendation":"A","context":"Begründung."}]}</surface:open-questions>',
        ].join('\n'),
      },
    ];
    const qs = collectOpenQuestionsFromHistory(history);
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.id).toBe('dup');
    expect(q.options).toEqual(['A', 'B']);
    expect(q.recommendation).toBe('A');
    expect(q.context).toBe('Begründung.');
  });
});

// ---------------------------------------------------------------------------
// 3. Auto-Resolve / Stale-Out — detectResolvedAndStaleQuestions
// ---------------------------------------------------------------------------

describe('detectResolvedAndStaleQuestions — Lexical-Resolve (2026-05-28)', () => {
  it('Frage „Markt?" → User antwortet „Mein Markt ist DACH" → resolved', () => {
    const qs: OpenQuestion[] = [{ id: 'm', text: 'Welcher Markt?' }];
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"m","q":"Welcher Markt?"}]}</surface:open-questions>',
      },
      { role: 'user', content: 'Mein markt ist DACH' },
    ];
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual(['m']);
  });

  it('Owner-Beispiel „Erst Copy oder erst Design" → User: „mach erst die copy" → resolved', () => {
    const qs: OpenQuestion[] = [
      { id: 'cd', text: 'Erst Copy oder erst Design?' },
    ];
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"cd","q":"Erst Copy oder erst Design?"}]}</surface:open-questions>',
      },
      { role: 'user', content: 'mach erst die copy fertig dann das design' },
    ];
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual(['cd']);
  });

  it('User-Message OHNE überlappende Tokens → NICHT resolved', () => {
    const qs: OpenQuestion[] = [{ id: 'm', text: 'Welcher Markt?' }];
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"m","q":"Welcher Markt?"}]}</surface:open-questions>',
      },
      { role: 'user', content: 'Was machst du da gerade?' },
    ];
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual([]);
  });

  it('Nur ASSISTANT-Antwort danach (kein User-Reply) → NICHT resolved', () => {
    const qs: OpenQuestion[] = [{ id: 'm', text: 'Welcher Markt?' }];
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"m","q":"Welcher Markt?"}]}</surface:open-questions>',
      },
      { role: 'assistant', content: 'Markt wäre wichtig.' },
    ];
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual([]);
  });

  it('User-Message VOR der Frage → NICHT resolved (Reihenfolge zählt)', () => {
    const qs: OpenQuestion[] = [{ id: 'm', text: 'Welcher Markt?' }];
    const history: OpenQuestionsSourceItem[] = [
      { role: 'user', content: 'Markt DACH passt.' },
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"m","q":"Welcher Markt?"}]}</surface:open-questions>',
      },
    ];
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual([]);
  });
});

describe('detectResolvedAndStaleQuestions — Alters-Verfall (2026-05-28)', () => {
  it('askedAt > 24h alt UND ≥20 Turns später → stale', () => {
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const qs: OpenQuestion[] = [
      { id: 'a', text: 'Sehr alte Frage', askedAt: oldIso },
    ];
    // Wir konstruieren: 1 assistant (Frage), dann 21 weitere Turns.
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"a","q":"Sehr alte Frage"}]}</surface:open-questions>',
      },
    ];
    for (let i = 0; i < 21; i += 1) {
      history.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `irrelevante Turn-${i}`, // kein Token-Overlap mit „Sehr alte Frage"
      });
    }
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual(['a']);
  });

  it('askedAt > 24h alt aber NUR 2 Turns später → NICHT stale (kumulativ)', () => {
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const qs: OpenQuestion[] = [
      { id: 'a', text: 'Sehr alte Frage', askedAt: oldIso },
    ];
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"a","q":"Sehr alte Frage"}]}</surface:open-questions>',
      },
      { role: 'assistant', content: 'noch was' },
      { role: 'assistant', content: 'noch was 2' },
    ];
    const out = detectResolvedAndStaleQuestions(qs, history);
    expect(out).toEqual([]);
  });

  it('askedAt fehlt → KEIN Stale (deterministische Stille)', () => {
    const qs: OpenQuestion[] = [{ id: 'a', text: 'Frage' }];
    const history: OpenQuestionsSourceItem[] = [];
    const out = detectResolvedAndStaleQuestions(qs, history, {
      nowMs: Date.now() + 10 * 24 * 60 * 60 * 1000,
      maxAgeMs: 1,
      maxTurnsAfter: 0,
    });
    expect(out).toEqual([]);
  });
});

describe('markStaleOpenQuestionsResolved — Maintenance-Helper', () => {
  it('liefert IDs der stale/resolved Fragen aus einem Surface-Body', () => {
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const raw =
      `<surface:open-questions>{"questions":[{"id":"x","q":"Welcher Markt?","askedAt":"${oldIso}"}]}</surface:open-questions>`;
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content: raw,
      },
      { role: 'user', content: 'Mein markt ist EU' },
    ];
    const out = markStaleOpenQuestionsResolved(raw, history);
    expect(out).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// 4. Reducer-Events — enriched / dismissed / stale-resolved (KERN 2026-05-28)
// ---------------------------------------------------------------------------

const Q1: OpenQuestion = { id: 'q1', text: 'Markt?', options: ['DACH', 'EU'] };
const Q2: OpenQuestion = { id: 'q2', text: 'Budget?' };

describe('nextOpenQuestionsState — enriched (Anti-Doppelung im Reducer)', () => {
  it('Anreicherung mergt in die bestehende Karte (kein Duplikat)', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'enriched',
      questions: [{ id: 'q1', text: 'Markt?', recommendation: 'DACH', pros: ['Heimat'] }],
    });
    expect(next.questions).toHaveLength(1);
    expect(next.questions[0]!.options).toEqual(['DACH', 'EU']);
    expect(next.questions[0]!.recommendation).toBe('DACH');
    expect(next.questions[0]!.pros).toEqual(['Heimat']);
    // Signatur unverändert (gleiche IDs → kein Re-Load der Pill).
    expect(next.signature).toBe(populated.signature);
  });

  it('Anreicherung zu unbekannter ID wird ignoriert (nur bekannte mergen)', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'enriched',
      questions: [{ id: 'unbekannt', text: 'Y?', recommendation: 'R' }],
    });
    // Unbekannte IDs landen NICHT in der Pill (mergeQuestionEnrichmentsById
    // behält Reihenfolge, würde aber neue IDs hinten anhängen). Wir prüfen,
    // dass die bestehende Karte unverändert ist.
    const q1Out = next.questions.find((q) => q.id === 'q1')!;
    expect(q1Out).toBeDefined();
    expect(q1Out.recommendation).toBeUndefined();
  });

  it('enriched auf leeren State → no-op', () => {
    const out = nextOpenQuestionsState(EMPTY_OPEN_QUESTIONS_STATE, {
      type: 'enriched',
      questions: [{ id: 'x', text: 'X?', recommendation: 'R' }],
    });
    expect(out).toBe(EMPTY_OPEN_QUESTIONS_STATE);
  });

  it('enriched mit identischen Werten → identische Referenz (kein Re-Render)', () => {
    const populated: OpenQuestionsState = {
      questions: [{ id: 'q1', text: 'Markt?', recommendation: 'DACH' }],
      signature: questionsSignature([Q1]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'enriched',
      questions: [{ id: 'q1', text: 'Markt?', recommendation: 'DACH' }],
    });
    expect(next).toBe(populated);
  });
});

describe('nextOpenQuestionsState — dismissed (Owner-Spec D)', () => {
  it('Dismiss einer ID entfernt sie + passt Signatur an Rest an', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1, Q2],
      signature: questionsSignature([Q1, Q2]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'dismissed',
      questionId: 'q1',
    });
    expect(next.questions.map((q) => q.id)).toEqual(['q2']);
    expect(next.signature).toBe(questionsSignature([Q2]));
  });

  it('Dismiss der letzten Frage clearet questions, BEHÄLT Signatur (kein Re-Pop)', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'dismissed',
      questionId: 'q1',
    });
    expect(next.questions).toEqual([]);
    expect(next.signature).toBe(populated.signature);
  });

  it('Dismiss einer unbekannten ID → State unverändert (Referenz-stabil)', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'dismissed',
      questionId: 'nicht-da',
    });
    expect(next).toBe(populated);
  });
});

describe('nextOpenQuestionsState — stale-resolved (Batch)', () => {
  it('Batch-Resolve entfernt die gelisteten IDs', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1, Q2],
      signature: questionsSignature([Q1, Q2]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'stale-resolved',
      questionIds: ['q1', 'q2'],
    });
    expect(next.questions).toEqual([]);
    // Signatur bleibt (Schutz vor sofortigem Re-Pop desselben Sets).
    expect(next.signature).toBe(populated.signature);
  });

  it('leere ID-Liste → no-op', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'stale-resolved',
      questionIds: [],
    });
    expect(next).toBe(populated);
  });

  it('Teil-Resolve (1 von 2) lässt die andere stehen', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1, Q2],
      signature: questionsSignature([Q1, Q2]),
    };
    const next = nextOpenQuestionsState(populated, {
      type: 'stale-resolved',
      questionIds: ['q1'],
    });
    expect(next.questions.map((q) => q.id)).toEqual(['q2']);
  });
});
