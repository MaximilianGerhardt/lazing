// Plan template — refactor (4 steps).
//
// BACKPORT-03 from Lazing-V2 (2026-05-23). Bytewise identical to the V2 source.
//
// Equivalence-preserving restructure. The hallmark step is
// `verify-equivalence` — characterisation tests + diff review confirm
// the behaviour is unchanged.

import type { PlanTemplate } from './index';

export const REFACTOR_REGEX =
  /\b(refactor(?:e|ed|ing)?|umbau(?:en|t)?|umstell(?:en|t|ung)|migrate|migriere|migration|restructure|umstrukturier(?:en|t)?|cleanup\s+(?:the\s+)?code|aufräumen|extract\s+(?:a\s+)?(?:function|class|module))\b/i;

export const refactorTemplate: PlanTemplate = {
  id: 'refactor',
  label: 'Refactor (baseline → refactor → verify equivalence → review)',
  estimatedComplexity: 'L',
  steps: [
    {
      index: 1,
      title: 'Capture a behavioural baseline (characterisation tests)',
      rationale:
        'Write green tests that pin the current behaviour BEFORE the restructure so post-refactor regressions show up immediately.',
      subagentRole: 'tester',
    },
    {
      index: 2,
      title: 'Perform the refactor in small, reviewable chunks',
      rationale:
        'Keep each commit individually green; avoid mixing renames, moves, and behaviour changes in the same diff.',
      subagentRole: 'coder',
    },
    {
      index: 3,
      title: 'Verify behavioural equivalence',
      rationale:
        'Re-run the baseline + full test suite; assert identical I/O on every public function; spot-check any non-deterministic paths manually.',
      subagentRole: 'tester',
    },
    {
      index: 4,
      title: 'Review the diff with fresh eyes',
      rationale:
        'Reviewer checks the rename map, the public surface, and any moved-not-changed files; flags anywhere intent leaked into the restructure.',
      subagentRole: 'reviewer',
    },
  ],
};
