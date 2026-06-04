// Plan-Templates library (BACKPORT-03 · 2026-05-23).
//
// 6 canonical plan templates keyed to common operator intents:
//
//   bug-fix              — 5 steps  (reproduce / locate / fix / verify / review)
//   feature-implement    — 7 steps  (research / design / scaffold / impl / test / docs / review)
//   refactor             — 4 steps  (baseline / refactor / verify-equivalence / review)
//   test-coverage        — 3 steps  (gap-analysis / write-tests / run)
//   perf-investigation   — 5 steps  (profile / hypothesise / micro-bench / optimise / verify)
//   security-audit       — 4 steps  (threat-model / static-audit / fix / re-audit)
//
// Der Matcher (`matchTemplate`) ist regex-basiert (N6 — deterministisch,
// kein LLM-Roundtrip) und ist nach Spezifität geordnet. Das bug-fix-
// Template hat höchste Priorität, weil Operatoren häufig bug-fix-Verben
// in breitere Feature-Requests einbetten — bug-fix bevorzugen wenn beide
// matchen vermeidet einen Hotfix versehentlich zu einem 7-Step-Feature-Plan
// hochzustufen.
//
// Discipline:
//   - N1: jeder Step's `title` + `rationale` ist VERBATIM aus diesem
//     Modul — kein slice, kein runtime reformat. Der Matcher
//     paraphrasiert NIE das Operator-Intent; er wählt nur ein Template.
//   - N6: deterministisch — gleicher `intentText` → matcher gibt IMMER
//     dasselbe Template (oder null).
//   - N4: Templates sind pure data + ein thin matcher. Keine Substrat-
//     Mutation; der Caller entscheidet ob ein Workstream aus den
//     Template-Steps geseeded wird.

import type { PlanStep, ProposedPlan } from '../orchestrate-plan';

import { bugFixTemplate, matchesBugFixIntent } from './bug-fix';
import { featureImplementTemplate, FEATURE_IMPLEMENT_REGEX } from './feature-implement';
import { refactorTemplate, REFACTOR_REGEX } from './refactor';
import { testCoverageTemplate, TEST_COVERAGE_REGEX } from './test-coverage';
import { perfInvestigationTemplate, PERF_INVESTIGATION_REGEX } from './perf-investigation';
import { securityAuditTemplate, SECURITY_AUDIT_REGEX } from './security-audit';

export type TemplateId =
  | 'bug-fix'
  | 'feature-implement'
  | 'refactor'
  | 'test-coverage'
  | 'perf-investigation'
  | 'security-audit';

export interface PlanTemplate {
  readonly id: TemplateId;
  readonly label: string;
  readonly estimatedComplexity: ProposedPlan['estimatedComplexity'];
  readonly steps: ReadonlyArray<Omit<PlanStep, 'id'>>;
}

// Bug-fix FIRST so it wins when multiple matchers fire.
//
// The bug-fix rule uses a custom `match` function instead of a single
// regex because correct bug-fix intent detection needs imperative-verb
// detection PLUS code-noun proximity gating for bug-nouns (2026-05-29
// Slice A — see `bug-fix.ts:matchesBugFixIntent` for the full
// rationale). All other rules remain single-regex.
const TEMPLATE_RULES: ReadonlyArray<{
  readonly template: PlanTemplate;
  readonly match: (text: string) => boolean;
}> = [
  { template: bugFixTemplate, match: matchesBugFixIntent },
  { template: securityAuditTemplate, match: (t) => SECURITY_AUDIT_REGEX.test(t) },
  { template: perfInvestigationTemplate, match: (t) => PERF_INVESTIGATION_REGEX.test(t) },
  { template: testCoverageTemplate, match: (t) => TEST_COVERAGE_REGEX.test(t) },
  { template: refactorTemplate, match: (t) => REFACTOR_REGEX.test(t) },
  { template: featureImplementTemplate, match: (t) => FEATURE_IMPLEMENT_REGEX.test(t) },
];

export const TEMPLATES_BY_ID: Readonly<Record<TemplateId, PlanTemplate>> = {
  'bug-fix': bugFixTemplate,
  'feature-implement': featureImplementTemplate,
  refactor: refactorTemplate,
  'test-coverage': testCoverageTemplate,
  'perf-investigation': perfInvestigationTemplate,
  'security-audit': securityAuditTemplate,
};

/**
 * Pure regex-based template selector (N6 deterministisch).
 *
 * Gibt das höchst-priorisierte Template zurück dessen Regex matched,
 * oder `null` wenn kein Template passt. Der Caller wird in diesem Fall
 * auf den LLM `proposePlan`-Flow zurückfallen.
 *
 * Priority order: bug-fix > security-audit > perf-investigation >
 * test-coverage > refactor > feature-implement. Order ist in
 * `TEMPLATE_RULES` hardcoded; nicht auf object-key iteration order
 * verlassen.
 */
export function matchTemplate(intentText: string): PlanTemplate | null {
  if (typeof intentText !== 'string') return null;
  const trimmed = intentText.trim();
  if (trimmed.length === 0) return null;
  for (const rule of TEMPLATE_RULES) {
    if (rule.match(trimmed)) return rule.template;
  }
  return null;
}

/**
 * Projektiert ein Template in eine `ProposedPlan`-Shape damit der selbe
 * downstream code-path (`planStepsToIntents` etc.) sowohl LLM-proposed
 * als auch template-matched Pläne ohne Branching treiben kann.
 *
 * Die geminteten Step-IDs werden vom Caller über `mintId` geliefert
 * damit Tests deterministische Ordering bekommen; default ist
 * `randomUUID()`.
 */
export function templateToProposedPlan(
  template: PlanTemplate,
  originalIntent: string,
  mintId: () => string,
  now: () => number = () => Date.now(),
): ProposedPlan {
  const steps: PlanStep[] = template.steps.map((s) => ({
    id: mintId(),
    index: s.index,
    title: s.title, // verbatim (N1)
    rationale: s.rationale, // verbatim (N1)
    ...(s.targetFiles ? { targetFiles: s.targetFiles } : {}),
    ...(s.subagentRole ? { subagentRole: s.subagentRole } : {}),
  }));
  return {
    id: mintId(),
    originalIntent, // verbatim (N1)
    steps,
    estimatedComplexity: template.estimatedComplexity,
    proposedAt: now(),
  };
}
