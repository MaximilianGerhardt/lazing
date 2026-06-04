// P0.3a — Self-Learning / WARUM-Engine (2026-05-27).
//
// Erweitert die WHY-Reichweite: proposePlan akzeptiert nun einen optionalen
// `whyContext`-Param (ein bereits gerenderter WARUM-Block). Wenn gesetzt + nicht
// leer, wird er dem buildPlanPrompt-Output VORANGESTELLT (analog compose.ts im
// Default-Decompose). Ohne den Param ist der an die Engine gereichte Prompt
// BIT-IDENTISCH zu vorher — bestehende Caller bleiben unverändert.
//
// Wir prüfen das über einen callEngine-Spy, der den empfangenen Prompt
// festhält und valides Plan-JSON zurückgibt (damit der deterministische
// parseProposedPlan-Validator ihn akzeptiert — N6: Validator bleibt davor).
//
// Test-Konvention: vitest · describe/it/expect (analog should-decompose.test.ts).
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { describe, expect, it } from 'vitest';

import { proposePlan, buildPlanPrompt } from '../orchestrate-plan';

/** Minimal-valides ProposedPlan-JSON (3 Steps) für parseProposedPlan. */
const PLAN_JSON = JSON.stringify({
  estimatedComplexity: 'M',
  steps: [
    { index: 1, title: 'Schema-Migration', rationale: 'Tabelle anlegen', subagentRole: 'coder' },
    { index: 2, title: 'Repo-Layer', rationale: 'CRUD-Queries', subagentRole: 'coder' },
    { index: 3, title: 'Tests', rationale: 'Abdeckung', subagentRole: 'tester' },
  ],
});

const WHY_BLOCK = [
  '── Frühere Entscheidungen in diesem Workspace / warum ──',
  'Jüngste Begründungen:',
  '  - [Routing] Higgsfield für Motion gewählt [Agent]',
  '── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──',
].join('\n');

const INTENT = 'Baue einen Audit-Log-Service';

describe('proposePlan — P0.3a WHY-Einspeisung (whyContext)', () => {
  it('MIT whyContext → WARUM-Block steht VOR dem buildPlanPrompt', async () => {
    const seen: string[] = [];
    const callEngine = async (prompt: string): Promise<string> => {
      seen.push(prompt);
      return PLAN_JSON;
    };

    const plan = await proposePlan(INTENT, callEngine, { whyContext: WHY_BLOCK });

    // Genau ein Engine-Call.
    expect(seen).toHaveLength(1);
    const prompt = seen[0];
    // Der WARUM-Block ist enthalten …
    expect(prompt).toContain('Frühere Entscheidungen in diesem Workspace');
    expect(prompt).toContain('Higgsfield für Motion gewählt');
    // … und steht VOR dem eigentlichen Plan-Designer-Prompt (Voranstellung).
    expect(prompt.indexOf(WHY_BLOCK)).toBeLessThan(prompt.indexOf('Operator-Intent:'));
    // Der base-Prompt (buildPlanPrompt) folgt vollständig nach dem Block.
    expect(prompt).toContain(buildPlanPrompt(INTENT));
    // Plan wurde trotzdem normal geparst.
    expect(plan.steps).toHaveLength(3);
  });

  it('OHNE whyContext → Prompt bit-identisch zum reinen buildPlanPrompt', async () => {
    const seen: string[] = [];
    const callEngine = async (prompt: string): Promise<string> => {
      seen.push(prompt);
      return PLAN_JSON;
    };

    await proposePlan(INTENT, callEngine);

    expect(seen).toHaveLength(1);
    // Bit-identisch zum reinen buildPlanPrompt — kein WARUM-Block eingesickert.
    expect(seen[0]).toBe(buildPlanPrompt(INTENT));
    expect(seen[0]).not.toContain('Frühere Entscheidungen in diesem Workspace');
  });

  it('leerer/whitespace whyContext → Identitäts-Pfad (bit-identisch)', async () => {
    const withEmpty: string[] = [];
    const withWs: string[] = [];

    await proposePlan(INTENT, async (p) => {
      withEmpty.push(p);
      return PLAN_JSON;
    }, { whyContext: '' });
    await proposePlan(INTENT, async (p) => {
      withWs.push(p);
      return PLAN_JSON;
    }, { whyContext: '   \n  ' });

    expect(withEmpty[0]).toBe(buildPlanPrompt(INTENT));
    expect(withWs[0]).toBe(buildPlanPrompt(INTENT));
  });

  it('whyContext umgeht den parseProposedPlan-Validator NICHT (N6)', async () => {
    // Trotz WARUM-Block muss ungültiges JSON weiterhin hart scheitern.
    await expect(
      proposePlan(INTENT, async () => 'kein valides json', { whyContext: WHY_BLOCK }),
    ).rejects.toThrow();
  });
});
