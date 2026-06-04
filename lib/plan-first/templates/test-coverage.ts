// Plan template — test-coverage (3 steps).
//
// BACKPORT-03 from Lazing-V2 (2026-05-23). Byte-identical to the V2 source.
//
// Short, focused loop for raising coverage on an existing module.
// Matches "schreibe Tests für …", "add tests for …", "cover module X".

import type { PlanTemplate } from './index';

export const TEST_COVERAGE_REGEX =
  /\b((schreib(?:e|en)?\s+(?:ein(?:en)?\s+|den\s+|die\s+|ein\s+paar\s+)?tests?)|(write\s+(?:a\s+|the\s+|some\s+)?tests?)|(add\s+(?:a\s+|the\s+|some\s+)?tests?)|coverage|teste\s+(?:den\s+|die\s+|das\s+))\b/i;

export const testCoverageTemplate: PlanTemplate = {
  id: 'test-coverage',
  label: 'Test coverage (gap analysis → write tests → run)',
  estimatedComplexity: 'M',
  steps: [
    {
      index: 1,
      title: 'Analyse the coverage gap',
      rationale:
        'List the public functions of the module, mark which already have tests, and which behaviours/edge-cases are uncovered.',
      subagentRole: 'tester',
    },
    {
      index: 2,
      title: 'Write the missing tests',
      rationale:
        'One test file per public function; cover happy path + at least two failure modes; mock external I/O at the lane boundary.',
      subagentRole: 'tester',
    },
    {
      index: 3,
      title: 'Run the full suite + report coverage delta',
      rationale:
        'Confirm green; capture the before/after coverage percentage so the operator sees the concrete gain.',
      subagentRole: 'tester',
    },
  ],
};
