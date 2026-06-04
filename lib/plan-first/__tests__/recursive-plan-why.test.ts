// E1 — Self-Learning / WARUM-Engine (2026-05-27).
//
// Erweitert die WHY-Reichweite vom flachen proposePlan (P0.3a) auf den
// REKURSIVEN Plan-Walker: proposeRecursivePlan/proposeLazySubplan reichen den
// optionalen `whyContext`-Block (frühere Begründungen + aktive Beliefs) an
// proposePlan durch — und zwar auf JEDER Ebene (Root + eager/lazy Subpläne).
// Frühere Begründungen gelten für den ganzen Plan-Baum, kein Re-Build pro Ebene.
//
// Ohne den Param ist der an die Engine gereichte Prompt auf jeder Ebene
// BIT-IDENTISCH zu vorher (E1.3 — bestehende Caller/Tests unverändert).
//
// Wir prüfen das über einen callEngine-Spy, der JEDEN empfangenen Prompt
// festhält und valides Plan-JSON zurückgibt (damit der deterministische
// parseProposedPlan-Validator ihn akzeptiert — N6).
//
// Test-Konvention: vitest · describe/it/expect (analog orchestrate-plan-why.test.ts).
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { describe, expect, it } from 'vitest';

import { buildPlanPrompt, type PlanStep } from '../orchestrate-plan';
import {
  proposeRecursivePlan,
  proposeLazySubplan,
  type ProposeRecursivePlanOpts,
} from '../recursive-plan';

const WHY_MARKER = 'Frühere Entscheidungen in diesem Workspace';
const WHY_BLOCK = [
  `── ${WHY_MARKER} / warum ──`,
  'Jüngste Begründungen:',
  '  - [Routing] Higgsfield für Motion gewählt [Agent]',
  '── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──',
].join('\n');

// Root-Plan: Step 1 trägt eine architect-Rolle + lange (>60 chars) feature-noun
// Beschreibung → subplanTrigger(step, 1) === true → eager depth-1-Subplan wird
// gemintet. So sehen wir mindestens ZWEI Engine-Calls (Root + Subplan).
//
// WICHTIG (LLM-Pfad erzwingen): Intent + Step-Titel/Rationale enthalten KEIN
// Template-Keyword (kein baue/implement/migration/audit/test/…), sonst würde
// matchTemplate kurzschließen und 0 Engine-Calls auslösen. "service/system/
// modul" sind feature-scope-Nouns für subplanTrigger, matchen aber KEINE
// Template-Regex (verifiziert).
const ROOT_PLAN_JSON = JSON.stringify({
  estimatedComplexity: 'L',
  steps: [
    {
      index: 1,
      title: 'Konzeption des Audit-Log-Service-Subsystems und seiner Modul-Grenzen',
      rationale: 'Komplexes Subsystem mit eigener Architektur — braucht eigene Zerlegung',
      subagentRole: 'architect',
    },
    { index: 2, title: 'Abschluss', rationale: 'Zusammenführung', subagentRole: 'reviewer' },
  ],
});

// Subplan-JSON (für die zweite/n Engine-Antwort/en).
const SUB_PLAN_JSON = JSON.stringify({
  estimatedComplexity: 'M',
  steps: [
    { index: 1, title: 'Sub-Schritt A', rationale: 'Detail A', subagentRole: 'coder' },
    { index: 2, title: 'Sub-Schritt B', rationale: 'Detail B', subagentRole: 'coder' },
  ],
});

// Template-neutraler Intent (kein baue/implement/… → LLM-Pfad statt Template).
const INTENT = 'Entwirf das Audit-Log-Service-System für diesen Workspace';

/** Spy-Engine: erster Call → Root-Plan, alle weiteren → Subplan. */
function makeSpyEngine(seen: string[]): (prompt: string) => Promise<string> {
  let n = 0;
  return async (prompt: string): Promise<string> => {
    seen.push(prompt);
    n += 1;
    return n === 1 ? ROOT_PLAN_JSON : SUB_PLAN_JSON;
  };
}

/** Force-LLM-Pfad: rootTemplate weglassen UND templates dürfen nicht greifen.
 *  Wir nutzen einen Intent ohne Template-Match-Trigger; falls doch ein Template
 *  matcht, prüfen wir nur die LLM-Calls die tatsächlich passieren. */
function baseOpts(seen: string[]): ProposeRecursivePlanOpts {
  let counter = 0;
  return {
    callEngine: makeSpyEngine(seen),
    cascadeMode: 'per-level',
    maxDepth: 1,
    mintId: () => `id-${(counter += 1)}`,
    now: () => 1_700_000_000_000,
  };
}

describe('proposeRecursivePlan — E1 WHY-Durchreichung (whyContext)', () => {
  it('MIT whyContext → WARUM-Block erreicht JEDE Plan-Ebene (Root + Subplan)', async () => {
    const seen: string[] = [];
    const recursive = await proposeRecursivePlan(INTENT, {
      ...baseOpts(seen),
      whyContext: WHY_BLOCK,
    });

    // Es gab mindestens einen Root- + einen Subplan-Call (eager depth-1).
    expect(seen.length).toBeGreaterThanOrEqual(2);

    // Jeder einzelne Engine-Prompt trägt den WARUM-Block VOR dem Plan-Designer.
    for (const prompt of seen) {
      expect(prompt).toContain(WHY_MARKER);
      expect(prompt).toContain('Higgsfield für Motion gewählt');
      expect(prompt.indexOf(WHY_BLOCK)).toBeLessThan(prompt.indexOf('Operator-Intent:'));
    }

    // Der Baum wurde trotzdem normal gebaut (eager depth-1-Kind existiert).
    expect(recursive.root.children.size).toBeGreaterThanOrEqual(1);
  });

  it('OHNE whyContext → jeder Ebenen-Prompt bit-identisch zum reinen buildPlanPrompt', async () => {
    const seen: string[] = [];
    await proposeRecursivePlan(INTENT, baseOpts(seen));

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const prompt of seen) {
      // Kein WARUM-Block eingesickert …
      expect(prompt).not.toContain(WHY_MARKER);
      // … und der Prompt ist exakt buildPlanPrompt(<intentText dieser Ebene>).
      // Wir rekonstruieren den intentText aus dem Prompt selbst, indem wir
      // prüfen dass buildPlanPrompt mit dem extrahierten Intent gleich ist.
      const m = prompt.match(/Operator-Intent: "([\s\S]*?)"\n/);
      expect(m).not.toBeNull();
      const intentText = m![1];
      expect(prompt).toBe(buildPlanPrompt(intentText));
    }
  });

  it('leerer/whitespace whyContext → Identitäts-Pfad (kein Block, bit-identisch)', async () => {
    const seenEmpty: string[] = [];
    const seenWs: string[] = [];

    await proposeRecursivePlan(INTENT, { ...baseOpts(seenEmpty), whyContext: '' });
    await proposeRecursivePlan(INTENT, { ...baseOpts(seenWs), whyContext: '   \n  ' });

    for (const prompt of [...seenEmpty, ...seenWs]) {
      expect(prompt).not.toContain(WHY_MARKER);
      const m = prompt.match(/Operator-Intent: "([\s\S]*?)"\n/);
      expect(m).not.toBeNull();
      expect(prompt).toBe(buildPlanPrompt(m![1]));
    }
  });
});

describe('proposeLazySubplan — E1 WHY-Durchreichung (whyContext)', () => {
  // Ein Step der subplanTrigger(step, depth=2) erfüllt: architect + feature-Noun.
  // Template-neutral (kein migration/refactor/… Keyword) → LLM-Pfad.
  const parentStep: PlanStep = {
    id: 'parent-1',
    index: 1,
    title: 'Konzeption des Event-Subsystems',
    rationale: 'feature-scope: eigene Architektur und Module nötig',
    subagentRole: 'architect',
  };

  it('MIT whyContext → lazy Subplan-Prompt trägt den WARUM-Block', async () => {
    const seen: string[] = [];
    const result = await proposeLazySubplan(parentStep, 2, {
      ...baseOpts(seen),
      whyContext: WHY_BLOCK,
    });

    expect(result).not.toBeNull();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const prompt of seen) {
      expect(prompt).toContain(WHY_MARKER);
      expect(prompt.indexOf(WHY_BLOCK)).toBeLessThan(prompt.indexOf('Operator-Intent:'));
    }
  });

  it('OHNE whyContext → lazy Subplan-Prompt bit-identisch zu buildPlanPrompt', async () => {
    const seen: string[] = [];
    const result = await proposeLazySubplan(parentStep, 2, baseOpts(seen));

    expect(result).not.toBeNull();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const prompt of seen) {
      expect(prompt).not.toContain(WHY_MARKER);
      const m = prompt.match(/Operator-Intent: "([\s\S]*?)"\n/);
      expect(m).not.toBeNull();
      expect(prompt).toBe(buildPlanPrompt(m![1]));
    }
  });
});
