// Plan template — feature-implement (7 steps).
//
// BACKPORT-03 von Lazing-V2 (2026-05-23). Bytewise identisch zur V2-Quelle.
//
// Canonical end-to-end feature delivery flow. Lowest priority in the
// matcher — anything more specific (bug-fix, security-audit, refactor)
// wins first.

import type { PlanTemplate } from './index';

export const FEATURE_IMPLEMENT_REGEX =
  /\b(implementiere|implement|programmiere|programmier|baue|build|erstelle|create|add\b|new\s+(?:feature|module|service|component|api|endpoint))\b/i;

export const featureImplementTemplate: PlanTemplate = {
  id: 'feature-implement',
  label: 'Feature implementation (research → design → impl → test → review)',
  estimatedComplexity: 'L',
  steps: [
    {
      index: 1,
      title: 'Research existing code + named adjacent patterns',
      rationale:
        'Inventory the modules the feature will touch; record N4 port targets so we extend instead of reinvent.',
      subagentRole: 'architect',
    },
    {
      index: 2,
      title: 'Sketch the architecture + interfaces',
      rationale:
        'Pin the new public surface (types, routes, schema rows) before any code lands so reviewers have a contract to check against.',
      subagentRole: 'architect',
    },
    {
      index: 3,
      title: 'Scaffold files + types',
      rationale:
        'Land empty modules with the agreed signatures; this becomes the merge unit each downstream step writes into.',
      subagentRole: 'coder',
    },
    {
      index: 4,
      title: 'Implement the core behaviour',
      rationale:
        'Fill in the substrate writes, route handlers, surface renderers — keep functions small and side-effects pinned to lane boundaries.',
      subagentRole: 'coder',
    },
    {
      index: 5,
      title: 'Write unit + integration tests',
      rationale:
        'Cover the happy path and at least two edge cases per public function; integration tests assert the wiring between modules.',
      subagentRole: 'tester',
    },
    {
      index: 6,
      title: 'Write operator-facing documentation',
      rationale:
        'Update the relevant docs / handoff so the next session can pick the feature up without re-reading the diff.',
      subagentRole: 'coder',
    },
    {
      index: 7,
      title: 'Review the full diff end-to-end',
      rationale:
        'Re-read every touched file; check N1 / N2 / N6 discipline, confirm no quarantined modules were ported without a recovery entry.',
      subagentRole: 'reviewer',
    },
  ],
};
