// Plan templates library (BACKPORT-03 · 2026-05-23).
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
// The matcher (`matchTemplate`) is regex-based (N6 — deterministic,
// no LLM roundtrip) and ordered by specificity. The bug-fix
// template has the highest priority because operators often embed bug-fix verbs
// in broader feature requests — preferring bug-fix when both
// match avoids accidentally promoting a hotfix to a 7-step feature plan.
//
// Discipline:
//   - N1: every step's `title` + `rationale` is VERBATIM from this
//     module — no slice, no runtime reformat. The matcher
//     NEVER paraphrases the operator intent; it only picks a template.
//   - N6: deterministic — the same `intentText` → the matcher ALWAYS gives
//     the same template (or null).
//   - N4: templates are pure data + a thin matcher. No substrate
//     mutation; the caller decides whether a workstream is seeded from the
//     template steps.

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
 * Pure regex-based template selector (N6 deterministic).
 *
 * Returns the highest-priority template whose regex matches,
 * or `null` when no template fits. In that case the caller
 * falls back to the LLM `proposePlan` flow.
 *
 * Priority order: bug-fix > security-audit > perf-investigation >
 * test-coverage > refactor > feature-implement. The order is hardcoded in
 * `TEMPLATE_RULES`; do not rely on object-key iteration order.
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
 * Projects a template into a `ProposedPlan` shape so the same
 * downstream code path (`planStepsToIntents` etc.) can drive both LLM-proposed
 * and template-matched plans without branching.
 *
 * The minted step IDs are supplied by the caller via `mintId`
 * so tests get deterministic ordering; the default is
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
