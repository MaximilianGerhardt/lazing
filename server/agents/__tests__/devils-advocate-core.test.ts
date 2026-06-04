/**
 * Devil's-Advocate Kern + Gating Tests (E4.1, P13, 2026-05-27).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run server/agents/__tests__/devils-advocate-core.test.ts
 *
 * Fokus (Plan §E4.4):
 *   - Der INJIZIERBARE Kern `evaluateDevilsAdvocate(engine, opts)` parst den
 *     Stub-Engine-Output zu counterPoints/verdict — OHNE echtes LLM.
 *   - „nicht falsifizierbar"-Flag (unfalsifiable) wird korrekt gesetzt.
 *   - Gating `shouldRunDevilsAdvocate`: läuft NUR bei consensus 'strong'
 *     ODER WHY-Einspeisung; sonst nicht.
 *
 * Das parser-Verhalten selbst ist zusätzlich in devils-advocate.test.ts
 * (node:test) abgedeckt — hier geht es um den injizierbaren Kern.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  evaluateDevilsAdvocate,
  shouldRunDevilsAdvocate,
  buildDevilsAdvocatePrompts,
  type DevilsAdvocateEngine,
  type DevilsAdvocateOpts,
} from '../devils-advocate';

const OPTS: DevilsAdvocateOpts = {
  workspaceId: 'ws-test',
  workspacePath: '/tmp/ws-test',
  workstreamId: 'WS-1',
  parentTicketId: 'TCK-1',
  synthesisText: 'Wir bauen X, weil es die UX verbessert.',
  originalPrompt: 'Plane Feature X.',
};

const FALSIFIABLE_OUTPUT = `
## Counter-Evidence

### Counter 1: User klickt nie
Wenn Telemetrie <2% Klicks zeigt, ist die These widerlegt.

### Counter 2: Latency-Hit
Wenn p99 > 200ms steigt, bricht die These.

### Counter 3: Sub-Tickets ungenutzt
Wenn 80% nach 7 Tagen offen, Premise widerlegt.

## Verdict
{verdict: "falsifiable"}
{counter_count: 3}
`;

const UNFALSIFIABLE_OUTPUT = `
## Counter-Evidence

Die These "X ist gut weil X gut ist" ist tautologisch.

## Verdict
{verdict: "unfalsifiable"}
{counter_count: 0}
`;

function stubEngine(text: string): DevilsAdvocateEngine {
  return vi.fn(async () => ({ text, costCents: 7, durationMs: 1234 }));
}

describe('evaluateDevilsAdvocate — injizierbarer Kern (kein echtes LLM)', () => {
  it('parst counterPoints + verdict aus dem Stub-Engine-Output', async () => {
    const engine = stubEngine(FALSIFIABLE_OUTPUT);
    const res = await evaluateDevilsAdvocate(engine, OPTS);

    expect(res.verdict).toBe('falsifiable');
    expect(res.counterEvidenceCount).toBe(3);
    expect(res.unfalsifiable).toBe(false);
    expect(res.text).toContain('Counter 1');
    expect(res.costCents).toBe(7);
    expect(res.durationMs).toBe(1234);
    expect(res.outputHash.length).toBeGreaterThan(0);
  });

  it('setzt das „nicht falsifizierbar"-Flag (rotes Flag) wenn kein Counter', async () => {
    const engine = stubEngine(UNFALSIFIABLE_OUTPUT);
    const res = await evaluateDevilsAdvocate(engine, OPTS);

    expect(res.verdict).toBe('unfalsifiable');
    expect(res.unfalsifiable).toBe(true);
    expect(res.counterEvidenceCount).toBe(0);
  });

  it('fällt bei leerem Engine-Output auf weak-evidence zurück (kein Crash)', async () => {
    const engine = stubEngine('');
    const res = await evaluateDevilsAdvocate(engine, OPTS);

    expect(res.verdict).toBe('weak-evidence');
    expect(res.unfalsifiable).toBe(false);
    expect(res.counterEvidenceCount).toBe(0);
    expect(res.text).toContain('fehlgeschlagen');
  });

  it('reicht den fertigen Prompt + synthesisHash an die Engine durch', async () => {
    const engine = stubEngine(FALSIFIABLE_OUTPUT);
    await evaluateDevilsAdvocate(engine, OPTS);

    expect(engine).toHaveBeenCalledTimes(1);
    const callArg = (engine as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg.systemPrompt).toContain("Devil's Advocate");
    expect(callArg.userPrompt).toContain(OPTS.synthesisText);
    expect(callArg.userPrompt).toContain(OPTS.originalPrompt);
    expect(typeof callArg.synthesisHash).toBe('string');
    expect(callArg.synthesisHash.length).toBeGreaterThan(0);
  });

  it('buildDevilsAdvocatePrompts ist rein + enthält Synthesis + Original', () => {
    const { systemPrompt, userPrompt } = buildDevilsAdvocatePrompts({
      synthesisText: 'SYNTH',
      originalPrompt: 'ORIG',
    });
    expect(systemPrompt).toContain('Falsifikator');
    expect(userPrompt).toContain('SYNTH');
    expect(userPrompt).toContain('ORIG');
  });
});

describe('shouldRunDevilsAdvocate — Gating (E4.1)', () => {
  it('läuft bei consensus_level=strong (auch ohne WHY)', () => {
    expect(
      shouldRunDevilsAdvocate({ consensusLevel: 'strong', whyInjected: false }),
    ).toBe(true);
  });

  it('läuft bei WHY-Einspeisung (auch ohne strong consensus)', () => {
    expect(
      shouldRunDevilsAdvocate({ consensusLevel: 'majority', whyInjected: true }),
    ).toBe(true);
    expect(
      shouldRunDevilsAdvocate({
        consensusLevel: 'disagreement',
        whyInjected: true,
      }),
    ).toBe(true);
  });

  it('läuft NICHT bei majority/disagreement OHNE WHY', () => {
    expect(
      shouldRunDevilsAdvocate({
        consensusLevel: 'majority',
        whyInjected: false,
      }),
    ).toBe(false);
    expect(
      shouldRunDevilsAdvocate({
        consensusLevel: 'disagreement',
        whyInjected: false,
      }),
    ).toBe(false);
  });

  it('läuft NICHT bei null/undefined consensus ohne WHY', () => {
    expect(
      shouldRunDevilsAdvocate({ consensusLevel: null, whyInjected: false }),
    ).toBe(false);
    expect(
      shouldRunDevilsAdvocate({ consensusLevel: undefined, whyInjected: false }),
    ).toBe(false);
  });
});
