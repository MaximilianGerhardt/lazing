/**
 * Tests für die Open-Questions-Lifecycle-Logik (Workstream 4b · 2026-05-27).
 *
 * OWNER-SYMPTOM: Eine im ask-but-proceed-Modus emittierte Frage scrollt weg,
 * weil sie nur als In-Stream-Karte rendert und beim Run-/Wellen-Ende verschwindet.
 *
 * Diese Tests sichern die KERN-Invarianten des Fixes (pur, ohne ChatShell-Mount):
 *  - Population aus BEIDEN Quellen: `<surface:open-questions>`-Tag UND
 *    `## Offene Fragen`-Markdown.
 *  - Scan über die GANZE History (jüngstes Frage-Set gewinnt).
 *  - Reducer: run-emittierte Frage → im State; Step-Done → State BLEIBT;
 *    Answer → Frage raus; Workstream-terminal → geclearet.
 *
 * Run: NODE_OPTIONS='--experimental-require-module' \
 *      node_modules/.bin/vitest run lib/chat/__tests__/open-questions-lifecycle.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  collectOpenQuestionsFromHistory,
  extractOpenQuestionsFromContent,
  nextOpenQuestionsState,
  questionsSignature,
  EMPTY_OPEN_QUESTIONS_STATE,
  type OpenQuestionsSourceItem,
  type OpenQuestionsState,
} from '../open-questions-lifecycle';
import type { PlanQuestion } from '../../workstreams/parse-plan-questions';

// ---------------------------------------------------------------------------
// extractOpenQuestionsFromContent — beide Quellen
// ---------------------------------------------------------------------------

describe('extractOpenQuestionsFromContent — Surface-Tag-Quelle', () => {
  it('zieht Fragen aus einem <surface:open-questions>-Tag (Feld `q`)', () => {
    const content = [
      'Ich starte den Build.',
      '<surface:open-questions>{"questions":[{"id":"s1","q":"Welcher Stack?","options":["Next","Remix"]}]}</surface:open-questions>',
      'server 200',
    ].join('\n');
    const qs = extractOpenQuestionsFromContent(content);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ id: 's1', text: 'Welcher Stack?' });
    expect(qs[0]!.options).toEqual(['Next', 'Remix']);
  });

  it('akzeptiert auch das Feld `text` statt `q`', () => {
    const content =
      '<surface:open-questions>{"questions":[{"id":"s2","text":"DB?"}]}</surface:open-questions>';
    const qs = extractOpenQuestionsFromContent(content);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ id: 's2', text: 'DB?' });
  });

  it('ignoriert kaputtes JSON ohne zu werfen', () => {
    const content =
      '<surface:open-questions>{nicht json}</surface:open-questions>';
    expect(extractOpenQuestionsFromContent(content)).toEqual([]);
  });
});

describe('extractOpenQuestionsFromContent — Markdown-Quelle', () => {
  it('zieht Fragen aus einer `## Offene Fragen`-Section', () => {
    const content = [
      'Antwort-Text.',
      '',
      '## Offene Fragen',
      '- [?] Welcher Markt? | OPTIONS: DACH | EU',
      '- [?] Welches Budget?',
    ].join('\n');
    const qs = extractOpenQuestionsFromContent(content);
    expect(qs).toHaveLength(2);
    expect(qs[0]!.text).toBe('Welcher Markt?');
    expect(qs[0]!.options).toEqual(['DACH', 'EU']);
    expect(qs[1]!.text).toBe('Welches Budget?');
  });

  it('liefert [] wenn weder Surface noch Markdown vorhanden', () => {
    expect(extractOpenQuestionsFromContent('nur normaler Text')).toEqual([]);
    expect(extractOpenQuestionsFromContent('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectOpenQuestionsFromHistory — jüngstes Frage-Set gewinnt, dedup
// ---------------------------------------------------------------------------

describe('collectOpenQuestionsFromHistory', () => {
  const userMsg: OpenQuestionsSourceItem = { role: 'user', content: 'Bau mir X' };

  it('findet die Frage auch wenn ein SPÄTERES Assistant-Item keine hat (Owner-Symptom: parallel weitergelaufen)', () => {
    const history: OpenQuestionsSourceItem[] = [
      userMsg,
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"s1","q":"Stack?"}]}</surface:open-questions>',
      },
      // Run läuft im ask-but-proceed weiter — späterer Turn ohne Frage.
      { role: 'assistant', content: 'Ich führe Bash aus … server 200' },
    ];
    const qs = collectOpenQuestionsFromHistory(history);
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ id: 's1', text: 'Stack?' });
  });

  it('jüngstes Assistant-Item mit Fragen gewinnt (neues Set ersetzt altes)', () => {
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"alt","q":"Alte Frage?"}]}</surface:open-questions>',
      },
      {
        role: 'assistant',
        content:
          '<surface:open-questions>{"questions":[{"id":"neu","q":"Neue Frage?"}]}</surface:open-questions>',
      },
    ];
    const qs = collectOpenQuestionsFromHistory(history);
    expect(qs).toHaveLength(1);
    expect(qs[0]!.id).toBe('neu');
  });

  it('dedupliziert per ID innerhalb desselben Items (Surface + Markdown gleiche Frage)', () => {
    // Markdown-ID = hashString(text); wir simulieren eine Kollision indem die
    // Surface dieselbe ID explizit vergibt. Erstes Vorkommen (Surface) gewinnt.
    const history: OpenQuestionsSourceItem[] = [
      {
        role: 'assistant',
        content: [
          '<surface:open-questions>{"questions":[{"id":"dup","q":"X?"}]}</surface:open-questions>',
          '## Offene Fragen',
          '- [?] Y?',
        ].join('\n'),
      },
    ];
    const qs = collectOpenQuestionsFromHistory(history);
    const ids = qs.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length); // keine Doppel-IDs
  });

  it('liefert [] bei leerer History', () => {
    expect(collectOpenQuestionsFromHistory([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// nextOpenQuestionsState — Lifecycle-Reducer (KERN-Invarianten 4b)
// ---------------------------------------------------------------------------

const Q1: PlanQuestion = { id: 'q1', text: 'Markt?', options: ['DACH', 'EU'] };
const Q2: PlanQuestion = { id: 'q2', text: 'Budget?' };

describe('nextOpenQuestionsState — Population', () => {
  it('run-emittierte Frage landet im State', () => {
    const s = nextOpenQuestionsState(EMPTY_OPEN_QUESTIONS_STATE, {
      type: 'questions-detected',
      questions: [Q1, Q2],
    });
    expect(s.questions).toEqual([Q1, Q2]);
    expect(s.signature).toBe(questionsSignature([Q1, Q2]));
  });

  it('gleiches Set (gleiche Signatur) lädt NICHT neu (Answer-Reset-Schutz)', () => {
    const first = nextOpenQuestionsState(EMPTY_OPEN_QUESTIONS_STATE, {
      type: 'questions-detected',
      questions: [Q1],
    });
    const second = nextOpenQuestionsState(first, {
      type: 'questions-detected',
      questions: [Q1],
    });
    expect(second).toBe(first); // identische Referenz → kein Re-Load
  });

  it('leeres Set ändert nichts', () => {
    const s = nextOpenQuestionsState(EMPTY_OPEN_QUESTIONS_STATE, {
      type: 'questions-detected',
      questions: [],
    });
    expect(s).toBe(EMPTY_OPEN_QUESTIONS_STATE);
  });
});

describe('nextOpenQuestionsState — Step-Done BLEIBT (Kern des Fixes)', () => {
  it('Step-Done clearet die gepinnte Frage NICHT', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1, Q2],
      signature: questionsSignature([Q1, Q2]),
    };
    const afterStep = nextOpenQuestionsState(populated, { type: 'step-done' });
    expect(afterStep).toBe(populated); // unverändert
    expect(afterStep.questions).toHaveLength(2);
  });

  it('mehrere Step-Done-Events hintereinander halten den State stabil', () => {
    let s: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    s = nextOpenQuestionsState(s, { type: 'step-done' });
    s = nextOpenQuestionsState(s, { type: 'step-done' });
    s = nextOpenQuestionsState(s, { type: 'step-done' });
    expect(s.questions).toEqual([Q1]);
  });
});

describe('nextOpenQuestionsState — Answer + Terminal', () => {
  it('Answer entfernt die Fragen, BEHÄLT die Signatur (kein Re-Pop)', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    const afterAnswer = nextOpenQuestionsState(populated, { type: 'answered' });
    expect(afterAnswer.questions).toEqual([]);
    expect(afterAnswer.signature).toBe(populated.signature);
  });

  it('nach Answer poppt DASSELBE Set NICHT wieder auf (Signatur-Guard)', () => {
    let s: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    s = nextOpenQuestionsState(s, { type: 'answered' });
    s = nextOpenQuestionsState(s, {
      type: 'questions-detected',
      questions: [Q1],
    });
    expect(s.questions).toEqual([]); // gleiche Signatur → kein Re-Load
  });

  it('nach Answer lädt ein NEUES Set (andere Signatur) normal nach', () => {
    let s: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    s = nextOpenQuestionsState(s, { type: 'answered' });
    s = nextOpenQuestionsState(s, {
      type: 'questions-detected',
      questions: [Q2],
    });
    expect(s.questions).toEqual([Q2]);
  });

  it('Workstream-terminal clearet Fragen UND Signatur', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1, Q2],
      signature: questionsSignature([Q1, Q2]),
    };
    const afterTerminal = nextOpenQuestionsState(populated, {
      type: 'workstream-terminal',
    });
    expect(afterTerminal.questions).toEqual([]);
    expect(afterTerminal.signature).toBeNull();
  });

  it('hard-reset setzt alles zurück', () => {
    const populated: OpenQuestionsState = {
      questions: [Q1],
      signature: questionsSignature([Q1]),
    };
    expect(nextOpenQuestionsState(populated, { type: 'hard-reset' })).toEqual(
      EMPTY_OPEN_QUESTIONS_STATE,
    );
  });
});

describe('nextOpenQuestionsState — vollständige ask-but-proceed-Sequenz', () => {
  it('detect → step-done → step-done → answer: Frage bleibt bis zur Antwort', () => {
    let s = EMPTY_OPEN_QUESTIONS_STATE;
    // Run emittiert Frage …
    s = nextOpenQuestionsState(s, {
      type: 'questions-detected',
      questions: [Q1],
    });
    expect(s.questions).toEqual([Q1]);
    // … Run arbeitet parallel weiter (Bash, server 200) …
    s = nextOpenQuestionsState(s, { type: 'step-done' });
    expect(s.questions).toEqual([Q1]); // GEPINNT geblieben
    s = nextOpenQuestionsState(s, { type: 'step-done' });
    expect(s.questions).toEqual([Q1]); // immer noch da
    // … User antwortet schließlich.
    s = nextOpenQuestionsState(s, { type: 'answered' });
    expect(s.questions).toEqual([]);
  });
});
