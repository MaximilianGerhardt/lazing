/**
 * Devil's Advocate Tests (P13, 2026-05-01).
 *
 * Run: `pnpm exec tsx --test server/agents/__tests__/devils-advocate.test.ts`
 *
 * Anne (Legaly-AI) Voll-Transkript: Confirmation-Bias-Counter im
 * Sniper-Loop. Tests konzentrieren sich auf den Parser — der DA-Spawn
 * selber ist tmux-basiert und integration-getestet, nicht unit-testbar.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { parseDevilsAdvocateOutput } from '../devils-advocate';

const FALSIFIABLE_OUTPUT = `
## Counter-Evidence

### Counter 1: User klickt nie auf Composer
Wenn die Telemetrie zeigt, dass <2% der User den Composer aktiv klicken,
ist die These "AutoSuggest verbessert UX" widerlegt.

### Counter 2: Latency-Hit durch Background-Spawn
Wenn p99-Latenz nach Aktivierung > 200ms steigt, bricht die These.

### Counter 3: Sub-Tickets bleiben unbearbeitet
Wenn 80% der DA-vorgeschlagenen Sub-Tickets nach 7 Tagen unbearbeitet
sind, ist die Premise "Devil's Advocate triggert Action" widerlegt.

## Falsifikations-Status
- [x] Falsifizierbar: drei konkrete Counter-Hypothesen formulierbar

## Verdict
{verdict: "falsifiable"}
{counter_count: 3}
`;

const UNFALSIFIABLE_OUTPUT = `
## Counter-Evidence

Die These "Das System ist gut weil es gut ist" lässt sich nicht
falsifizieren — sie ist tautologisch.

## Falsifikations-Status
- [x] Nicht falsifizierbar: These ist tautologisch oder unprüfbar

## Verdict
{verdict: "unfalsifiable"}
{counter_count: 0}
`;

const WEAK_OUTPUT = `
## Counter-Evidence

### Counter 1: Edge-Case mit Disconnect
Wenn der User offline geht während Synthesis läuft, könnte die Card
kaputtgehen.

## Verdict
{verdict: "weak-evidence"}
{counter_count: 1}
`;

const MALFORMED_OUTPUT = `
Hier hat das LLM nichts Brauchbares geliefert. Kein Verdict-Block.
Counter-Evidence: keine.
`;

const SINGLE_QUOTES = `
## Verdict
{verdict: 'falsifiable'}
{counter_count: 4}
`;

const NO_BRACES = `
## Verdict
verdict: "unfalsifiable"
counter_count: 0
`;

describe('parseDevilsAdvocateOutput — happy path', () => {
  it('liest verdict=falsifiable und counter_count=3', () => {
    const parsed = parseDevilsAdvocateOutput(FALSIFIABLE_OUTPUT);
    assert.equal(parsed.verdict, 'falsifiable');
    assert.equal(parsed.counterCount, 3);
    assert.equal(parsed.unfalsifiable, false);
  });

  it('liest verdict=unfalsifiable und setzt unfalsifiable=true', () => {
    const parsed = parseDevilsAdvocateOutput(UNFALSIFIABLE_OUTPUT);
    assert.equal(parsed.verdict, 'unfalsifiable');
    assert.equal(parsed.counterCount, 0);
    assert.equal(parsed.unfalsifiable, true);
  });

  it('liest verdict=weak-evidence', () => {
    const parsed = parseDevilsAdvocateOutput(WEAK_OUTPUT);
    assert.equal(parsed.verdict, 'weak-evidence');
    assert.equal(parsed.counterCount, 1);
    assert.equal(parsed.unfalsifiable, false);
  });
});

describe('parseDevilsAdvocateOutput — edge cases', () => {
  it('fallback bei malformedem Output: weak-evidence + count=0', () => {
    const parsed = parseDevilsAdvocateOutput(MALFORMED_OUTPUT);
    assert.equal(parsed.verdict, 'weak-evidence');
    assert.equal(parsed.counterCount, 0);
    assert.equal(parsed.unfalsifiable, false);
  });

  it('akzeptiert single-quotes im verdict-Marker', () => {
    const parsed = parseDevilsAdvocateOutput(SINGLE_QUOTES);
    assert.equal(parsed.verdict, 'falsifiable');
    assert.equal(parsed.counterCount, 4);
  });

  it('akzeptiert verdict ohne geschweifte Klammern', () => {
    const parsed = parseDevilsAdvocateOutput(NO_BRACES);
    assert.equal(parsed.verdict, 'unfalsifiable');
    assert.equal(parsed.counterCount, 0);
    assert.equal(parsed.unfalsifiable, true);
  });

  it('clamped counter_count auf max 5', () => {
    const parsed = parseDevilsAdvocateOutput(`
{verdict: "falsifiable"}
{counter_count: 99}
    `);
    assert.equal(parsed.counterCount, 5);
  });

  it('clamped counter_count auf min 0', () => {
    // Negative regex-match: regex ist \d+, "-3" matched nur "3".
    // Test dokumentiert das Verhalten — kein Min-Underflow.
    const parsed = parseDevilsAdvocateOutput(`
{verdict: "falsifiable"}
{counter_count: 0}
    `);
    assert.equal(parsed.counterCount, 0);
  });

  it('case-insensitive verdict-match', () => {
    const parsed = parseDevilsAdvocateOutput(`
{VERDICT: "FALSIFIABLE"}
{counter_count: 2}
    `);
    assert.equal(parsed.verdict, 'falsifiable');
    assert.equal(parsed.counterCount, 2);
  });
});
