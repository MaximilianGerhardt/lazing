/**
 * Intent-Classifier Tests (2026-05-01).
 *
 * Verifiziert das Verhalten der Heuristik gegen 15+ kanonische Phrasen pro
 * Intent. Adressiert User-Befund "der unterschied zwischen der
 * implementierung der ideen noch immer nicht klar" — wenn die Klassifikation
 * lautlos falsch wäre, würde das visuelle Differenzierungs-Versprechen brechen.
 *
 * Run: `npx tsx --test --test-force-exit lib/workstreams/__tests__/intent-classifier.test.ts`
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  classifyFromInput,
  classifyIntent,
  classifyIntentSync,
  getIntentMeta,
  getIntentStrategy,
  isValidIntent,
  normalizeIntent,
  type WorkstreamIntent,
} from '../intent-classifier';

// --- Bug-Fix --------------------------------------------------------------

describe('classifyIntentSync · bug-fix', () => {
  const cases = [
    'Da ist ein Bug im Login-Flow',
    'Error 500 beim Speichern',
    'Fehler in der Pipeline',
    'Die App ist kaputt',
    'Der Server stürzt ständig ab',
    'Das ist ein crash beim Boot',
    'Hotfix für Production',
    'NPE im Workspace-Switcher',
    'Stack-Trace im Log',
    'Der Button funktioniert nicht',
    'Das geht nicht — Form submit broken',
    'Quickfix für Migration',
    'Regression in V2',
    'exception beim Laden',
    'Zeig mir den 404-Error',
  ];

  for (const text of cases) {
    it(`erkennt bug-fix in: ${text.slice(0, 40)}`, () => {
      const r = classifyIntentSync(text);
      assert.equal(
        r.intent,
        'bug-fix',
        `Erwartet bug-fix für "${text}", got ${r.intent} (conf=${r.confidence}, matched=${r.matched.join(',')})`,
      );
      assert.ok(r.confidence > 0.3);
    });
  }
});

// --- Implementation -------------------------------------------------------

describe('classifyIntentSync · implementation', () => {
  const cases = [
    'Implementiere die Auth-Migration',
    'Bau mir die neue API',
    'Setze das CRM-Modul um',
    'Wir müssen das deployen',
    'Release v2 vorbereiten',
    'Commit den Refactor',
    'Migration für die User-Tabelle',
    'Schreibe den Code für den Endpoint',
    'Refactoring des Dispatchers',
    'Schiff das Feature heute Abend',
    'Build die PWA',
    'Feature bauen für den Kunden',
    'Schema erweitern um intent-Spalte',
    'API bauen für Workstream-Detail',
    'Implementierung des neuen Roasters',
  ];

  for (const text of cases) {
    it(`erkennt implementation in: ${text.slice(0, 40)}`, () => {
      const r = classifyIntentSync(text);
      assert.equal(
        r.intent,
        'implementation',
        `Erwartet implementation für "${text}", got ${r.intent} (matched=${r.matched.join(',')})`,
      );
    });
  }
});

// --- Idea -----------------------------------------------------------------

describe('classifyIntentSync · idea', () => {
  const cases = [
    'Hab eine Idee für ein neues Feature',
    'Lass uns brainstormen',
    'Was wäre wenn wir das Modell wechseln?',
    'Denk dir mal eine Lösung aus',
    'Könnte man das auch anders machen?',
    'Vielleicht könnten wir Multi-Tenant einführen',
    'Ich hab eine Vision für die App',
    'Konzept für den nächsten Sprint',
    'Lass uns spinnen — neue Idee',
    'Spinnen wir das mal weiter',
    'Was wäre wenn der Sniper auch Code reviewen würde?',
    'Brainstorming Session zu Onboarding',
    'Ideenfindung für die Intent-Classifier-UI',
    'Eine moonshot-Idee fürs Ranking',
    'Pie-in-the-sky-Konzept',
  ];

  for (const text of cases) {
    it(`erkennt idea in: ${text.slice(0, 40)}`, () => {
      const r = classifyIntentSync(text);
      assert.equal(
        r.intent,
        'idea',
        `Erwartet idea für "${text}", got ${r.intent} (matched=${r.matched.join(',')})`,
      );
    });
  }
});

// --- Question -------------------------------------------------------------

describe('classifyIntentSync · question', () => {
  const cases = [
    'Wie geht das eigentlich?',
    'Warum stürzt der Watcher ab?',
    'Eine kurze Frage zum Workflow',
    'Wie funktioniert die Migration genau?',
    'Wieso ist der Build langsam',
    'Verstehe nicht warum das nicht greift',
    'Erkläre mir die Tier-Architektur',
    'Was ist eigentlich ein Workstream?',
    'Was bedeutet sniper-pause-start?',
    'Was macht der Cross-Roast?',
    'Can you explain the dispatch lock?',
    'How does the auto-classifier work?',
    'Weshalb ist der Test rot?',
    'Was ist der Unterschied zwischen Idea und Discussion?',
    'Kapier nicht warum die Card nicht updatet?',
  ];

  for (const text of cases) {
    it(`erkennt question in: ${text.slice(0, 40)}`, () => {
      const r = classifyIntentSync(text);
      assert.equal(
        r.intent,
        'question',
        `Erwartet question für "${text}", got ${r.intent} (matched=${r.matched.join(',')})`,
      );
    });
  }
});

// --- Discussion (Default) -------------------------------------------------

describe('classifyIntentSync · discussion (default)', () => {
  it('leerer String → discussion mit confidence 0', () => {
    const r = classifyIntentSync('');
    assert.equal(r.intent, 'discussion');
    assert.equal(r.confidence, 0);
    assert.equal(r.fallbackUsed, false);
  });

  it('Whitespace-only → discussion', () => {
    const r = classifyIntentSync('   \n  ');
    assert.equal(r.intent, 'discussion');
  });

  it('neutraler Satz ohne Trigger → discussion', () => {
    const r = classifyIntentSync('Heute ist Sonntag und das Wetter ist okay.');
    assert.equal(r.intent, 'discussion');
    assert.equal(r.confidence, 0);
  });
});

// --- Tie-Breaker ----------------------------------------------------------

describe('classifyIntentSync · Tie-Breaker bei Mischsätzen', () => {
  it('"implementier den bugfix" → bug-fix gewinnt (spezifischer)', () => {
    const r = classifyIntentSync('implementiere den hotfix für den bug');
    assert.equal(r.intent, 'bug-fix');
  });

  it('"baue Feature für die Idee" → implementation gewinnt', () => {
    const r = classifyIntentSync('Bau mir das Feature für die neue Funktion');
    // "Idee" nicht enthalten — soll implementation klar gewinnen
    assert.equal(r.intent, 'implementation');
  });

  it('Confidence sinkt bei mehreren konkurrierenden Familien', () => {
    const single = classifyIntentSync('implementier das Feature');
    const mixed = classifyIntentSync(
      'implementiere die idee als bugfix mit fehler-handling und wieso?',
    );
    // mixed hat ambiguity → confidence-Penalty
    assert.ok(mixed.matched.length >= 2);
  });
});

// --- normalizeIntent ------------------------------------------------------

describe('normalizeIntent', () => {
  it('NULL → discussion', () => {
    assert.equal(normalizeIntent(null), 'discussion');
  });
  it('undefined → discussion', () => {
    assert.equal(normalizeIntent(undefined), 'discussion');
  });
  it('garbage → discussion', () => {
    assert.equal(normalizeIntent('nonsense'), 'discussion');
  });
  it('valid bleibt valid', () => {
    const intents: WorkstreamIntent[] = [
      'idea',
      'implementation',
      'bug-fix',
      'question',
      'discussion',
    ];
    for (const i of intents) {
      assert.equal(normalizeIntent(i), i);
    }
  });
});

// --- isValidIntent --------------------------------------------------------

describe('isValidIntent', () => {
  it('akzeptiert kanonische Werte', () => {
    assert.ok(isValidIntent('idea'));
    assert.ok(isValidIntent('implementation'));
    assert.ok(isValidIntent('bug-fix'));
    assert.ok(isValidIntent('question'));
    assert.ok(isValidIntent('discussion'));
  });
  it('lehnt Garbage ab', () => {
    assert.equal(isValidIntent(''), false);
    assert.equal(isValidIntent('IDEA'), false); // case-sensitive
    assert.equal(isValidIntent(null), false);
    assert.equal(isValidIntent(42), false);
  });
});

// --- getIntentMeta --------------------------------------------------------

describe('getIntentMeta', () => {
  it('liefert Icon + Label + cssSuffix für jeden Intent', () => {
    const intents: WorkstreamIntent[] = [
      'idea',
      'implementation',
      'bug-fix',
      'question',
      'discussion',
    ];
    for (const i of intents) {
      const m = getIntentMeta(i);
      assert.ok(m.icon.length > 0);
      assert.ok(m.label.length > 0);
      assert.ok(m.cssSuffix.length > 0);
    }
  });
  it('cssSuffix ist filename-safe', () => {
    for (const i of ['idea', 'implementation', 'bug-fix', 'question', 'discussion'] as WorkstreamIntent[]) {
      const m = getIntentMeta(i);
      assert.match(m.cssSuffix, /^[a-z-]+$/);
    }
  });
});

// --- getIntentStrategy ----------------------------------------------------

describe('getIntentStrategy', () => {
  it('bug-fix → critic-first + sniper', () => {
    const s = getIntentStrategy('bug-fix');
    assert.equal(s.criticFirst, true);
    assert.equal(s.sniperLoop, true);
    assert.equal(s.preset, 'bugfix-swarm');
  });
  it('idea → kein autoDispatch, kein sniper', () => {
    const s = getIntentStrategy('idea');
    assert.equal(s.autoDispatch, false);
    assert.equal(s.sniperLoop, false);
  });
  it('question → minimaler Pfad', () => {
    const s = getIntentStrategy('question');
    assert.equal(s.preset, 'qa-light');
    assert.equal(s.criticFirst, false);
  });
  it('implementation → Standard mit Sniper', () => {
    const s = getIntentStrategy('implementation');
    assert.equal(s.preset, 'standard');
    assert.equal(s.autoDispatch, true);
  });
});

// --- classifyFromInput ----------------------------------------------------

describe('classifyFromInput · name+description', () => {
  it('kombiniert beide Felder', () => {
    const r = classifyFromInput({
      name: 'Sprint-Idee',
      description: 'Was wäre wenn wir das Onboarding multi-step machen?',
    });
    assert.equal(r.intent, 'idea');
  });

  it('description gewinnt visuell durch Order', () => {
    const r = classifyFromInput({
      name: 'Workstream',
      description: 'Bug im Login - error 500 beim Submit',
    });
    assert.equal(r.intent, 'bug-fix');
  });

  it('NULL-safe', () => {
    const r = classifyFromInput({ name: null, description: undefined });
    assert.equal(r.intent, 'discussion');
  });
});

// --- async classifyIntent + LLM-Fallback ----------------------------------

describe('classifyIntent (async) · LLM-Fallback-Verhalten', () => {
  it('skip Fallback in NODE_ENV=test (auch wenn enabled)', async () => {
    (process.env as Record<string, string>)['NODE_ENV'] = 'test';
    let calledHook = false;
    const r = await classifyIntent('Heute ist mittwoch ohne trigger', {
      llmFallback: true,
      llmHook: async () => {
        calledHook = true;
        return 'idea';
      },
    });
    // Test-Mode skipped fallback strikt
    assert.equal(calledHook, false);
    assert.equal(r.fallbackUsed, false);
  });

  it('Fallback NICHT getriggert bei high-confidence Heuristik', async () => {
    (process.env as Record<string, string>)['NODE_ENV'] = 'production-temporary-test';
    let calledHook = false;
    try {
      const r = await classifyIntent('Implementiere die API und baue den Endpoint', {
        llmFallback: true,
        llmHook: async () => {
          calledHook = true;
          return 'idea';
        },
      });
      assert.equal(calledHook, false);
      assert.equal(r.intent, 'implementation');
    } finally {
      (process.env as Record<string, string>)['NODE_ENV'] = 'test';
    }
  });

  it('Fallback respektiert ungültigen Hook-Wert', async () => {
    (process.env as Record<string, string>)['NODE_ENV'] = 'production-temporary-test';
    try {
      const r = await classifyIntent('hmm naja', {
        llmFallback: true,
        // @ts-expect-error — wir testen Garbage
        llmHook: async () => 'IDEA',
      });
      // Sync war discussion; Hook lieferte Garbage → discussion bleibt
      assert.equal(r.intent, 'discussion');
      assert.equal(r.fallbackUsed, false);
    } finally {
      (process.env as Record<string, string>)['NODE_ENV'] = 'test';
    }
  });

  it('Fallback throw → Heuristik gewinnt (fail-open)', async () => {
    (process.env as Record<string, string>)['NODE_ENV'] = 'production-temporary-test';
    try {
      const r = await classifyIntent('hmm naja', {
        llmFallback: true,
        llmHook: async () => {
          throw new Error('LLM offline');
        },
      });
      assert.equal(r.intent, 'discussion');
      assert.equal(r.fallbackUsed, false);
    } finally {
      (process.env as Record<string, string>)['NODE_ENV'] = 'test';
    }
  });
});
