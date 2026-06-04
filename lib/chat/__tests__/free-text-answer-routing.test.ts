/**
 * Bug-2-Fix · Free-Text-Antwort-Kopplung · 2026-05-30
 * ---------------------------------------------------
 * Live-Browser-Befund (verbatim): Tippt der User FREI „Eigenes Video" statt
 * eine offene tier-choice/quickchoice-Card anzuklicken, während eine Frage
 * offen ist, fällt der Text durch `classifyFlowIntent` (min 3 Wörter + Verb →
 * 'unknown') in den normalen Chat → der Agent wirft einen DRITTEN Tiefe-Picker
 * statt es als Antwort zu verstehen.
 *
 * FIX: `shouldRouteFreeTextAsAnswer(...)` — das pure Predicate, das der
 * submit-Handler nutzt, um Free-Text an die offene Frage zu koppeln, statt einen
 * neuen Plan zu starten. Hier pur getestet (kein ChatShell-Mount).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/free-text-answer-routing.test.ts
 */

import { describe, expect, it } from 'vitest';

import { shouldRouteFreeTextAsAnswer } from '../ChatShell';
import { classifyFlowIntent } from '../intent-flow-classifier';

const base = {
  hasStaged: false,
  pillExpanded: false,
  openQuestionCount: 1,
  classify: classifyFlowIntent,
} as const;

describe('shouldRouteFreeTextAsAnswer · Bug-2 (Free-Text-Kopplung)', () => {
  it('„Eigenes Video" bei offener Frage → wird als ANTWORT geroutet (kein 3. Picker)', () => {
    // Das genaue Live-Test-Symptom: kurze Free-Text-Antwort, classifyFlowIntent
    // liefert 'unknown' (2 Wörter, kein Imperativ).
    expect(classifyFlowIntent('Eigenes Video').kind).toBe('unknown');
    expect(shouldRouteFreeTextAsAnswer({ ...base, value: 'Eigenes Video' })).toBe(
      true,
    );
  });

  it('längere Free-Text-Antwort ohne Flow-Intent bei offener Frage → Antwort', () => {
    const value = 'Lieber das eigene Video von uns nehmen bitte';
    expect(classifyFlowIntent(value).kind).toBe('unknown');
    expect(shouldRouteFreeTextAsAnswer({ ...base, value })).toBe(true);
  });

  it('confident Flow-Intent („erstelle eine Webseite") → NICHT abfangen, neuer Flow', () => {
    const value = 'erstelle eine Webseite für meine Agentur';
    expect(classifyFlowIntent(value).kind).toBe('flow');
    expect(shouldRouteFreeTextAsAnswer({ ...base, value })).toBe(false);
  });

  it('Slash-Command bei offener Frage → NICHT abfangen (expliziter Befehl)', () => {
    expect(
      shouldRouteFreeTextAsAnswer({ ...base, value: '/clear' }),
    ).toBe(false);
  });

  it('keine offenen Fragen → niemals abfangen (normaler Chat)', () => {
    expect(
      shouldRouteFreeTextAsAnswer({
        ...base,
        value: 'Eigenes Video',
        openQuestionCount: 0,
      }),
    ).toBe(false);
  });

  it('Pille ausgeklappt → der pillExpanded-Pfad hat Vorrang (hier false)', () => {
    expect(
      shouldRouteFreeTextAsAnswer({
        ...base,
        value: 'Eigenes Video',
        pillExpanded: true,
      }),
    ).toBe(false);
  });

  it('gestagete Anhänge → NICHT abfangen (File-Send-Intent)', () => {
    expect(
      shouldRouteFreeTextAsAnswer({
        ...base,
        value: 'Eigenes Video',
        hasStaged: true,
      }),
    ).toBe(false);
  });

  it('leerer/whitespace Input → false', () => {
    expect(shouldRouteFreeTextAsAnswer({ ...base, value: '   ' })).toBe(false);
  });
});
