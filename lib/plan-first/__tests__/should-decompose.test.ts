// N6-Entry-Gate Tests — deterministischer Pre-Screen für Plan-Zerlegung.
//
// BACKPORT-03 (2026-05-23 · Agent Phase C-1).
//
// Test-Konvention: vitest · describe/it/expect (analog templates.test.ts).
// Runner: pnpm vitest run --reporter=verbose
//
// 12 Akzeptanz-Cases aus der Spec. Alle müssen grün sein.

import { describe, expect, it } from 'vitest';

import { shouldDecompose } from '../should-decompose';

describe('shouldDecompose — N6 deterministisches Entry-Gate', () => {
  // -----------------------------------------------------------------------
  // Case 1 — Mehrstufiges deutsches Verb + Projekt-Noun + "und"-Chaining
  // Erwartet: decompose = true
  // -----------------------------------------------------------------------
  it('case 1: mehrstufige DE-Anfrage mit Auth-Service (decompose = true)', () => {
    const r = shouldDecompose(
      'Implementiere einen Auth-Service mit JWT und Refresh-Tokens und schreibe Tests',
    );
    expect(r.decompose).toBe(true);
    // S1 muss gefeuert haben (implementiere).
    expect(r.signals.some((s) => s.name === 'S1 multi-step-verb-de')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 2 — Multi-Verb EN + Projekt-Keywords (api, database, schema)
  // Erwartet: decompose = true
  // -----------------------------------------------------------------------
  it('case 2: multi-verb EN REST API + schema + deploy (decompose = true)', () => {
    const r = shouldDecompose(
      'Build a REST API, add a database schema, deploy to Vercel',
    );
    expect(r.decompose).toBe(true);
    expect(r.signals.some((s) => s.name === 'S2 multi-step-verb-en')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 3 — Reine Wissensfrage endet mit ? und kein Step-Verb (S10-Veto)
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 3: pure question "Was ist JWT?" — S10 veto (decompose = false)', () => {
    const r = shouldDecompose('Was ist JWT?');
    expect(r.decompose).toBe(false);
    // S10 muss negativ gewichtet gefeuert haben.
    expect(r.signals.some((s) => s.name === 'S10 pure-question-veto')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 4 — Erklär-Frage ohne Step-Verb und kein Fragezeichen
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 4: Erklär-Anfrage ohne Step-Verb (decompose = false)', () => {
    const r = shouldDecompose(
      'Erkläre den Unterschied zwischen REST und GraphQL',
    );
    expect(r.decompose).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Case 5 — Einzelnes nacktes Verb (refactor) OHNE Korroboration.
  // Codex-Parität (2026-06-02, Threshold 2→3): ein nacktes Step-Verb poppt
  // KEINE Plan-Karte mehr — Codex/Claude Code erledigen/erfragen das direkt.
  // Das Verb-Signal feuert weiterhin (Score 2), reicht aber nicht für decompose.
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 5: nacktes EN-Verb "Refactor" → Score 2, kein Plan (decompose = false)', () => {
    const r = shouldDecompose('Refactor');
    expect(r.decompose).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(2);
    expect(r.signals.some((s) => s.name === 'S2 multi-step-verb-en')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 6 — Kurze Fix-Anweisung ohne Step-Verb
  // "fix" ist NICHT in S1/S2 — bewusstes Design: Bug-Fix ≠ Plan-Vorhaben.
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 6: "Fix the bug in line 42" — kein Step-Verb (decompose = false)', () => {
    const r = shouldDecompose('Fix the bug in line 42');
    expect(r.decompose).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Case 7 — DE-Verb + nummerierte Liste mit ≥ 2 Einträgen + Feature-Keyword
  // Erwartet: decompose = true
  // -----------------------------------------------------------------------
  it('case 7: erstelle + nummerierte Liste 1./2./3. (decompose = true)', () => {
    const r = shouldDecompose(
      'Erstelle ein Feature für User-Registrierung: 1. Formular 2. Validierung 3. DB-Insert',
    );
    expect(r.decompose).toBe(true);
    // S5 list-marker muss erkannt worden sein.
    expect(r.signals.some((s) => s.name === 'S5 list-marker')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 8 — S12 Negation-Guard: "kurz" in den ersten 40 Zeichen
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 8: "kurz" in Prefix — S12 negation-guard (decompose = false)', () => {
    const r = shouldDecompose(
      'Schreib mir kurz eine Funktion die zwei Zahlen addiert',
    );
    expect(r.decompose).toBe(false);
    expect(r.signals.some((s) => s.name === 'S12 negation-guard')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 9 — Langer EN-Prompt mit migrate + schema + mehreren "and"
  // Erwartet: decompose = true
  // -----------------------------------------------------------------------
  it('case 9: migrate + schema + multi-and chaining (decompose = true)', () => {
    const r = shouldDecompose(
      'Migrate the existing PostgreSQL schema to SQLite, update all ORM queries, fix failing tests, and update the CI pipeline',
    );
    expect(r.decompose).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 10 — Komplexes SaaS-Backend (DE-Verb + Backend-Keyword)
  // Erwartet: decompose = true
  // -----------------------------------------------------------------------
  it('case 10: "Baue ein komplettes SaaS-Backend …" (decompose = true)', () => {
    const r = shouldDecompose(
      'Baue ein komplettes SaaS-Backend mit Auth, Billing, Multi-Tenant-Schema und Admin-Panel',
    );
    expect(r.decompose).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Case 11 — Einwort-Dankesformel — keinerlei Signal
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 11: "Danke" — keine Signale (decompose = false)', () => {
    const r = shouldDecompose('Danke');
    expect(r.decompose).toBe(false);
    expect(r.score).toBeLessThan(2);
  });

  // -----------------------------------------------------------------------
  // Case 12 — Einzelnes nacktes Verb "Deploy" OHNE Korroboration.
  // Codex-Parität (2026-06-02, Threshold 2→3): nacktes Verb → kein Auto-Plan.
  // Das S2-Signal feuert (Score 2), aber decompose bleibt false.
  // Erwartet: decompose = false
  // -----------------------------------------------------------------------
  it('case 12: nacktes EN-Verb "Deploy" → Score 2, kein Plan (decompose = false)', () => {
    const r = shouldDecompose('Deploy');
    expect(r.decompose).toBe(false);
    expect(r.signals.some((s) => s.name === 'S2 multi-step-verb-en')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Zusatz: Determinismus-Check — gleicher Input → identischer Output
  // -----------------------------------------------------------------------
  it('ist deterministisch — gleicher Input → gleicher Output', () => {
    const prompt = 'Implementiere einen Auth-Service mit JWT';
    const a = shouldDecompose(prompt);
    const b = shouldDecompose(prompt);
    expect(a.decompose).toBe(b.decompose);
    expect(a.score).toBe(b.score);
    expect(a.signals).toEqual(b.signals);
  });
});
