/**
 * Demo PV (photovoltaic) regression eval · Test cases (8)
 * ════════════════════════════════════════════════════════════════════════
 *
 * The 8 test cases as declarative fixtures. Each case describes WHAT a build
 * artifact must contain (requiredDomainObjects + requiredExpertDecisions) and
 * WHAT makes it fail (blockerIf).
 *
 * Test cases (8): simple-roof · complex-roof · stringing-constraint ·
 *   storage-sizing · crm-handoff · expert-gate · bad-automation · tool-replacement.
 *
 * Blocker criterion:
 *   "The plan is blocked when: only a roof drawer / PV simulation depth
 *    deferred / no stringing/inverter/storage model / expert review optional /
 *    CRM note only / no distinction between sales/proposal/install grade."
 *
 * These blockers are encoded as named `BlockerId`s; evaluate.ts evaluates each
 * blocker deterministically (N6) against the artifact.
 */

import type { DomainObjectKind, ExpertDecisionId, PvArtifact } from './domain-model';

// ───────────────────────────────────────────────────────────────────────────
// Blocker vocabulary (1:1 with the verbatim blocker criterion)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Each blocker maps to one clause of the blocker criterion. evaluate.ts
 * implements one deterministic detector per BlockerId.
 */
export type BlockerId =
  /** "only roof drawer" — RoofPlane(s) without any electrical objects. */
  | 'only-roof-drawer'
  /** "PV simulation depth deferred" — no simulation run despite proposal/install claim. */
  | 'pv-depth-deferred'
  /** "no stringing/inverter/storage model" — string/inverter/battery missing. */
  | 'no-electrical-model'
  /** Stringing domain rule violated (voltage window/MPPT). */
  | 'stringing-rule-violated'
  /** "expert review optional" — install-grade approval without expertReviewed. */
  | 'expert-review-optional'
  /** "CRM note only" — CRM sync event without structured fields. */
  | 'crm-note-only'
  /** "no distinction between sales/proposal/install grade" — approval grade missing/uniform. */
  | 'no-approval-grade-distinction';

export const BLOCKER_IDS: readonly BlockerId[] = [
  'only-roof-drawer',
  'pv-depth-deferred',
  'no-electrical-model',
  'stringing-rule-violated',
  'expert-review-optional',
  'crm-note-only',
  'no-approval-grade-distinction',
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Test case structure
// ───────────────────────────────────────────────────────────────────────────

export type TestCaseId =
  | 'simple-roof'
  | 'complex-roof'
  | 'stringing-constraint'
  | 'storage-sizing'
  | 'crm-handoff'
  | 'expert-gate'
  | 'bad-automation'
  | 'tool-replacement';

export interface PvEvalTestCase {
  id: TestCaseId;
  /** Owner-prompt style — how the lead-to-design workflow would be triggered. */
  intent: string;
  /** Object kinds the artifact MUST contain. */
  requiredDomainObjects: DomainObjectKind[];
  /** Expert decisions that MUST have been taken. */
  requiredExpertDecisions: ExpertDecisionId[];
  /** Blockers this case is armed against. If one trips -> fail. */
  blockerIf: BlockerId[];
}

// ───────────────────────────────────────────────────────────────────────────
// The 8 test cases
// ───────────────────────────────────────────────────────────────────────────

export const PV_EVAL_TEST_CASES: readonly PvEvalTestCase[] = [
  {
    id: 'simple-roof',
    intent:
      'New lead, detached single-family house, one south-facing gable roof. ' +
      'Create a technical PV quote.',
    requiredDomainObjects: [
      'lead',
      'building',
      'roof-plane',
      'module',
      'string',
      'inverter',
      'simulation-run',
      'quote',
      'approval',
    ],
    requiredExpertDecisions: ['stringing-validated', 'yield-simulated'],
    blockerIf: [
      'only-roof-drawer',
      'pv-depth-deferred',
      'no-electrical-model',
      'no-approval-grade-distinction',
    ],
  },
  {
    id: 'complex-roof',
    intent:
      'Lead with a hip roof, multiple roof planes of different orientation ' +
      '(east/west/south) plus a dormer and a chimney. Plan the module layout.',
    requiredDomainObjects: [
      'lead',
      'building',
      'roof-plane',
      'obstruction',
      'module',
      'string',
      'inverter',
      'simulation-run',
      'quote',
      'approval',
    ],
    requiredExpertDecisions: [
      'multi-plane-layout',
      'shading-assessed',
      'stringing-validated',
    ],
    blockerIf: [
      'only-roof-drawer',
      'pv-depth-deferred',
      'no-electrical-model',
      'stringing-rule-violated',
    ],
  },
  {
    id: 'stringing-constraint',
    intent:
      'Given a module/inverter combination: check whether the string layout ' +
      'stays within the DC voltage window and the MPPT trackers.',
    requiredDomainObjects: ['module', 'string', 'inverter'],
    requiredExpertDecisions: ['stringing-validated'],
    blockerIf: ['no-electrical-model', 'stringing-rule-violated'],
  },
  {
    id: 'storage-sizing',
    intent:
      'Customer with a heat pump and an EV wants maximum autarky. ' +
      'Size the battery storage to match the load profile.',
    requiredDomainObjects: [
      'lead',
      'consumption-profile',
      'battery',
      'inverter',
      'simulation-run',
    ],
    requiredExpertDecisions: ['storage-sized', 'charge-strategy-chosen'],
    blockerIf: ['no-electrical-model', 'pv-depth-deferred'],
  },
  {
    id: 'crm-handoff',
    intent:
      'Hand off the qualified lead together with the technical quote in a ' +
      'structured way to the CRM (not as a free-text note).',
    requiredDomainObjects: ['lead', 'quote', 'crm-sync-event'],
    requiredExpertDecisions: ['crm-fields-mapped'],
    blockerIf: ['crm-note-only'],
  },
  {
    id: 'expert-gate',
    intent:
      'The quote should be raised to install grade. Make sure a domain ' +
      'expert signs off on the string layout and the structural check.',
    requiredDomainObjects: ['quote', 'approval', 'building'],
    requiredExpertDecisions: ['expert-reviewed', 'statics-checked'],
    blockerIf: ['expert-review-optional', 'no-approval-grade-distinction'],
  },
  {
    id: 'bad-automation',
    intent:
      'The system proposes automating the entire design without human review. ' +
      'Recognize that install grade must NOT be approved fully automatically.',
    requiredDomainObjects: ['approval'],
    requiredExpertDecisions: ['expert-reviewed'],
    blockerIf: ['expert-review-optional', 'no-approval-grade-distinction'],
  },
  {
    id: 'tool-replacement',
    intent:
      'An existing tool stack (PV simulation tool + a separate CRM + Excel ' +
      'quotes) should be replaced. Deliver an integrated domain model that ' +
      'does NOT defer the depth of the specialist tools.',
    requiredDomainObjects: [
      'building',
      'roof-plane',
      'module',
      'string',
      'inverter',
      'battery',
      'simulation-run',
      'quote',
      'crm-sync-event',
    ],
    requiredExpertDecisions: [
      'tool-replacement-decided',
      'stringing-validated',
      'yield-simulated',
    ],
    blockerIf: [
      'only-roof-drawer',
      'pv-depth-deferred',
      'no-electrical-model',
      'crm-note-only',
    ],
  },
] as const;

export const PV_EVAL_TEST_CASE_IDS: readonly TestCaseId[] = PV_EVAL_TEST_CASES.map(
  (c) => c.id,
);

/** Lookup helper. */
export function getTestCase(id: TestCaseId): PvEvalTestCase {
  const c = PV_EVAL_TEST_CASES.find((t) => t.id === id);
  if (!c) throw new Error(`Unknown PV eval test case: ${id}`);
  return c;
}

// Re-export for convenient consumption by evaluate.ts + tests.
export type { PvArtifact };
