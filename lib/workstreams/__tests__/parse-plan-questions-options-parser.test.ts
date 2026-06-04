/**
 * parse-plan-questions — OPTIONS-Parser-Fix (2026-05-29, C1–C4).
 *
 * Bug-Report (Max, Handoff §9): „Erst Copy oder erst Design?" zerfiel zu
 * 4 statt 3 Optionen, weil "Copy zuerst (SOP-Logik, empfohlen)" am internen
 * Komma gesplittet wurde. Fix:
 *   C1 — Pipe als einziger Trenner (Komma raus).
 *   C2 — JSON-First-Path über `OPTIONS_JSON: [...]`.
 *   C3 — Whitespace-Normalisierung + leere Optionen verwerfen.
 *   C4 — opt-in `repairLegacyOptions` für persistierte defekte Arrays.
 */
import { describe, expect, it } from 'vitest';
import { parsePlanQuestions, repairLegacyOptions } from '../parse-plan-questions';

describe('parsePlanQuestions — OPTIONS-Parser (C1 Pipe-only)', () => {
  it('C1 — Komma INNERHALB einer Option zerstört die Option nicht', () => {
    const plan = `## Offene Fragen
- [?] Erst Copy oder erst Design? | OPTIONS: Copy zuerst (SOP-Logik, empfohlen) | Design zuerst | Beides parallel
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].text).toBe('Erst Copy oder erst Design?');
    expect(qs[0].options).toEqual([
      'Copy zuerst (SOP-Logik, empfohlen)',
      'Design zuerst',
      'Beides parallel',
    ]);
  });

  it('C1 — "A | B | C" ergibt genau 3 Optionen', () => {
    const plan = `## Offene Fragen
- [?] Tech-Stack? | OPTIONS: A | B | C
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual(['A', 'B', 'C']);
  });

  it('C1 — "A | B (mit, Komma) | C" → 3 Optionen, mittlere bleibt intakt', () => {
    const plan = `## Offene Fragen
- [?] Welcher Akzent? | OPTIONS: A | B (mit, Komma) | C
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual(['A', 'B (mit, Komma)', 'C']);
  });

  it('C1 — Komma ist KEIN Trenner mehr: "A, B, C" → 1 einzige Option', () => {
    // Regressions-Schutz: das ALTE Verhalten (Komma als Trenner) wäre hier 3
    // Optionen — wir verlangen explizit 1, weil Pipe der einzige Trenner ist.
    // Wenn künftig jemand das alte Verhalten zurückbringt, schlägt das hier
    // sofort fehl und der Owner sieht den Regress.
    const plan = `## Offene Fragen
- [?] Frage? | OPTIONS: A, B, C
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual(['A, B, C']);
  });
});

describe('parsePlanQuestions — OPTIONS_JSON (C2)', () => {
  it('C2 — OPTIONS_JSON akzeptiert strukturierte JSON-Arrays', () => {
    const plan = `## Offene Fragen
- [?] Welche Option? | OPTIONS_JSON: ["A","B (mit, Komma)","C"]
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].text).toBe('Welche Option?');
    expect(qs[0].options).toEqual(['A', 'B (mit, Komma)', 'C']);
  });

  it('C2 — Owner-Datenprobe via JSON: Copy/Design/Parallel sauber', () => {
    const plan = `## Offene Fragen
- [?] Erst Copy oder erst Design? | OPTIONS_JSON: ["Copy zuerst (SOP-Logik, empfohlen)","Design zuerst","Beides parallel"]
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual([
      'Copy zuerst (SOP-Logik, empfohlen)',
      'Design zuerst',
      'Beides parallel',
    ]);
  });

  it('C2 — kaputtes JSON → Question rutscht als Free-Text durch (sicher)', () => {
    const plan = `## Offene Fragen
- [?] Frage? | OPTIONS_JSON: [nicht, valid, json]
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toBeUndefined();
    // text fällt auf den raw rawText zurück, damit kein Verlust:
    expect(qs[0].text).toContain('Frage?');
  });

  it('C2 — JSON cap auf 5 Optionen', () => {
    const plan = `## Offene Fragen
- [?] Viele? | OPTIONS_JSON: ["1","2","3","4","5","6","7"]
`;
    const qs = parsePlanQuestions(plan);
    expect(qs[0].options).toEqual(['1', '2', '3', '4', '5']);
  });

  it('C2 — JSON mit Nicht-String-Einträgen filtert die raus', () => {
    const plan = `## Offene Fragen
- [?] Mix? | OPTIONS_JSON: ["A",42,null,"B",true,"C"]
`;
    const qs = parsePlanQuestions(plan);
    expect(qs[0].options).toEqual(['A', 'B', 'C']);
  });
});

describe('parsePlanQuestions — Whitespace + leer (C3)', () => {
  it('C3 — Whitespace um Optionen wird getrimmt', () => {
    const plan = `## Offene Fragen
- [?] Frage? | OPTIONS:   A   |   B   |   C
`;
    const qs = parsePlanQuestions(plan);
    expect(qs[0].options).toEqual(['A', 'B', 'C']);
  });

  it('C3 — leere Optionen werden verworfen', () => {
    const plan = `## Offene Fragen
- [?] Frage? | OPTIONS: A |   | B |  | C
`;
    const qs = parsePlanQuestions(plan);
    expect(qs[0].options).toEqual(['A', 'B', 'C']);
  });
});

describe('repairLegacyOptions (C4)', () => {
  it('C4 — heilt persistierte Owner-Daten (4 Fragmente → 3 Optionen)', () => {
    // Genau die Daten aus dem Handoff §9.
    const broken = [
      'Copy zuerst (SOP-Logik',
      'empfohlen)',
      'Design zuerst',
      'Beides parallel',
    ];
    expect(repairLegacyOptions(broken)).toEqual([
      'Copy zuerst (SOP-Logik, empfohlen)',
      'Design zuerst',
      'Beides parallel',
    ]);
  });

  it('C4 — Roundtrip-stabil auf intakten Arrays', () => {
    const ok = ['A', 'B', 'C'];
    expect(repairLegacyOptions(ok)).toEqual(['A', 'B', 'C']);
  });

  it('C4 — verlustfrei: nicht-geschlossene Klammern bleiben erhalten', () => {
    const partial = ['Foo (bar', 'baz'];
    // Heuristik: ein offener `(` + Folge ohne `)` → join, Buffer flusht am Ende.
    expect(repairLegacyOptions(partial)).toEqual(['Foo (bar, baz']);
  });

  it('C4 — leere Strings + Whitespace werden verworfen', () => {
    expect(repairLegacyOptions(['  ', '', 'A', ' ', 'B'])).toEqual(['A', 'B']);
  });

  it('C4 — Cap auf 5 (gleiche Cap wie Parser)', () => {
    expect(
      repairLegacyOptions(['1', '2', '3', '4', '5', '6', '7']),
    ).toEqual(['1', '2', '3', '4', '5']);
  });

  it('C4 — Edge: leeres Array → []', () => {
    expect(repairLegacyOptions([])).toEqual([]);
  });
});

describe('parsePlanQuestions — Backward-Compat', () => {
  it('bestehende Pipe-only-Pläne (pill-answer-routing-Stil) bleiben grün', () => {
    const plan = `## Offene Fragen
- Welches Budget? | OPTIONS: Klein | Groß
`;
    const qs = parsePlanQuestions(plan);
    expect(qs).toHaveLength(1);
    expect(qs[0].options).toEqual(['Klein', 'Groß']);
  });
});
