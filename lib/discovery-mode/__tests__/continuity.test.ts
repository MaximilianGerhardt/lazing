/**
 * lib/discovery-mode/__tests__/continuity.test.ts
 * -----------------------------------------------
 * Tests für lib/discovery-mode/continuity.ts (§6 / §20.3, N6 deterministisch).
 *
 * Abdeckung (Aufgaben-Pflicht (d)):
 *   priorMode→nextMode liefert stillValid / superseded / missing korrekt.
 *
 * Run: `pnpm vitest run lib/discovery-mode/__tests__/continuity.test.ts`
 */
import { describe, expect, it } from 'vitest';
import { continuityCheck, type PriorKnowledge } from '../continuity';

const idea: PriorKnowledge = {
  id: 'b1',
  text: 'Wir könnten ein Self-Service-Onboarding bauen.',
  originMode: 'brainstorm',
  kind: 'idea',
};
const rule: PriorKnowledge = {
  id: 'b2',
  text: 'Vor jedem Release läuft die QA-SOP. Verbatim festgehalten, nicht gekürzt.',
  originMode: 'extract_expertise',
  kind: 'rule',
};
const vision: PriorKnowledge = {
  id: 'd1',
  text: 'Vision: lokal-first, fail-closed, kein globales RAG.',
  originMode: 'reconcile',
  kind: 'vision',
};
const plan: PriorKnowledge = {
  id: 'd2',
  text: 'Plan: Schema → Repo → Policy → Runtime.',
  originMode: 'plan_graph',
  kind: 'plan',
};

describe('continuityCheck — stillValid', () => {
  it('clarify→plan_graph: Regel + Vision bleiben gültig', () => {
    const cp = continuityCheck({
      priorMode: 'clarify',
      nextMode: 'plan_graph',
      priorBeliefs: [rule],
      priorDecisions: [vision],
    });
    const validIds = cp.stillValid.map((v) => v.id).sort();
    expect(validIds).toEqual(['b2', 'd1']);
    expect(cp.superseded).toHaveLength(0);
    // Verbatim erhalten (N1) — kein gekürzter Text.
    expect(cp.stillValid.find((v) => v.id === 'b2')!.text).toBe(rule.text);
  });
});

describe('continuityCheck — superseded', () => {
  it('brainstorm→innovate: alte brainstorm-Idee wird überholt', () => {
    const cp = continuityCheck({
      priorMode: 'brainstorm',
      nextMode: 'innovate',
      priorBeliefs: [idea, rule],
    });
    expect(cp.superseded.map((s) => s.id)).toEqual(['b1']);
    expect(cp.stillValid.map((s) => s.id)).toEqual(['b2']); // Regel bleibt Fundament
    expect(cp.superseded[0].reason).toMatch(/überholt/i);
  });

  it('innovate→plan_graph: lose Idee geht im Plan auf (superseded)', () => {
    const cp = continuityCheck({
      priorMode: 'innovate',
      nextMode: 'plan_graph',
      priorBeliefs: [idea],
      priorDecisions: [vision],
    });
    expect(cp.superseded.map((s) => s.id)).toEqual(['b1']);
    expect(cp.stillValid.map((s) => s.id)).toEqual(['d1']); // Vision bleibt
  });

  it('same-mode (kein Reframe) → nichts wird überholt', () => {
    const cp = continuityCheck({
      priorMode: 'innovate',
      nextMode: 'innovate',
      priorBeliefs: [idea],
    });
    expect(cp.superseded).toHaveLength(0);
    expect(cp.stillValid.map((s) => s.id)).toEqual(['b1']);
  });
});

describe('continuityCheck — missing + mayPlan (§20.3 Frage 4+5)', () => {
  it('clarify→build ohne Plan → kritische Lücke "plan", mayPlan=false', () => {
    const cp = continuityCheck({
      priorMode: 'clarify',
      nextMode: 'build',
      priorBeliefs: [rule],
    });
    expect(cp.missing.some((m) => m.kind === 'plan')).toBe(true);
    expect(cp.mayPlan).toBe(false);
  });

  it('plan_graph→build MIT Plan → keine Plan-Lücke, mayPlan=true', () => {
    const cp = continuityCheck({
      priorMode: 'plan_graph',
      nextMode: 'build',
      priorDecisions: [plan],
    });
    expect(cp.missing.some((m) => m.kind === 'plan')).toBe(false);
    // role ist non-critical missing → blockiert mayPlan NICHT
    expect(cp.mayPlan).toBe(true);
  });

  it('clarify→reconcile ohne Vision → kritische Lücke, mayPlan=false', () => {
    const cp = continuityCheck({
      priorMode: 'clarify',
      nextMode: 'reconcile',
      priorBeliefs: [rule],
    });
    expect(cp.missing.some((m) => m.kind === 'vision')).toBe(true);
    expect(cp.mayPlan).toBe(false);
  });

  it('Wechsel in No-Plan-Modus (innovate) → mayPlan=false trotz Wissen', () => {
    const cp = continuityCheck({
      priorMode: 'plan_graph',
      nextMode: 'innovate',
      priorBeliefs: [rule],
      priorDecisions: [vision],
    });
    expect(cp.mayPlan).toBe(false);
    expect(cp.summary).toMatch(/blockiert/i);
  });

  it('summary zählt gültig/überholt/Lücken korrekt', () => {
    const cp = continuityCheck({
      priorMode: 'brainstorm',
      nextMode: 'plan_graph',
      priorBeliefs: [idea, rule],
      priorDecisions: [vision],
    });
    // idea (b1) superseded; rule (b2) + vision (d1) valid; plan-kind fehlt?
    // plan_graph fordert rule (vorhanden) + vision (vorhanden, critical) → keine kritische Lücke.
    expect(cp.summary).toContain('2 gültig');
    expect(cp.summary).toContain('1 überholt');
    expect(cp.mayPlan).toBe(true);
  });
});
