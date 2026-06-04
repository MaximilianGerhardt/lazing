/**
 * Demo PV (photovoltaic) regression eval · Evaluator
 * ════════════════════════════════════════════════════════════════════════
 *
 * `evaluateArtifact(artifact, testCase)` is a DETERMINISTIC (N6) pure
 * function — no LLM, no I/O, no randomness. It checks:
 *
 *   1. Does the artifact contain all `requiredDomainObjects`?  -> missingObjects
 *   2. Does it contain all `requiredExpertDecisions`?          -> missingDecisions
 *   3. Does a `blockerIf` condition apply?                     -> trippedBlockers
 *
 * `passed` is true only when missingObjects + missingDecisions +
 * trippedBlockers are ALL empty. This implements the anti-MVP gate:
 * "just a surface without domain rules/expert decisions -> fails the gate".
 *
 * Integration point: the verdict feeds quality gate G5 (domain depth) of the
 * portfolio spine — see `toG5GateResult`. An artifact that fails here must
 * not pass the `critic-eval-gates` stage (stage 9).
 */

import type { QualityGateResult } from '@/lib/portfolio/types';

import {
  presentObjectKinds,
  stringingViolations,
  type Approval,
  type CrmSyncEvent,
  type DomainObjectKind,
  type ExpertDecisionId,
  type PvArtifact,
} from './domain-model';
import type { BlockerId, PvEvalTestCase } from './test-cases';

export interface EvalVerdict {
  testCaseId: string;
  passed: boolean;
  /** Required object kinds that are missing. */
  missingObjects: DomainObjectKind[];
  /** Required expert decisions that are missing. */
  missingDecisions: ExpertDecisionId[];
  /** Blockers that were tripped — with a verbatim reason. */
  trippedBlockers: { blocker: BlockerId; reason: string }[];
}

// ───────────────────────────────────────────────────────────────────────────
// Blocker detectors — one deterministic check per BlockerId.
// Returns a verbatim reason when the blocker applies; otherwise null.
// ───────────────────────────────────────────────────────────────────────────

type BlockerDetector = (artifact: PvArtifact) => string | null;

const BLOCKER_DETECTORS: Record<BlockerId, BlockerDetector> = {
  // "only roof drawer": RoofPlane(s) present, but NO electrical object.
  'only-roof-drawer': (a) => {
    const kinds = presentObjectKinds(a);
    const hasRoof = kinds.has('roof-plane') || kinds.has('building');
    const hasElectrical =
      kinds.has('string') || kinds.has('inverter') || kinds.has('module');
    return hasRoof && !hasElectrical
      ? 'Only roof/building objects, no electrical model (module/string/inverter).'
      : null;
  },

  // "PV simulation depth deferred": no simulation run although strings/modules exist.
  'pv-depth-deferred': (a) => {
    const kinds = presentObjectKinds(a);
    const hasGeneration = kinds.has('string') || kinds.has('module');
    return hasGeneration && !kinds.has('simulation-run')
      ? 'Generation objects present, but no simulation run (yield depth deferred).'
      : null;
  },

  // "no stringing/inverter/storage model": string/inverter missing.
  'no-electrical-model': (a) => {
    const kinds = presentObjectKinds(a);
    const missing: DomainObjectKind[] = (['string', 'inverter'] as const).filter(
      (k) => !kinds.has(k),
    );
    return missing.length > 0
      ? `Electrical core model incomplete — missing: ${missing.join(', ')}.`
      : null;
  },

  // Stringing domain rule violated (voltage window/MPPT).
  'stringing-rule-violated': (a) => {
    const v = stringingViolations(a);
    return v.length > 0 ? `Stringing rule violated: ${v.join(' | ')}` : null;
  },

  // "expert review optional": install-grade approval without expertReviewed.
  'expert-review-optional': (a) => {
    const approvals = a.objects.filter(
      (o): o is Approval => o.kind === 'approval',
    );
    const offenders = approvals.filter(
      (ap) => ap.grade === 'install' && !ap.expertReviewed,
    );
    return offenders.length > 0
      ? `Install-grade approval(s) without expert review: ${offenders
          .map((o) => o.id)
          .join(', ')}.`
      : null;
  },

  // "CRM note only": CRM sync event without structured fields.
  'crm-note-only': (a) => {
    const events = a.objects.filter(
      (o): o is CrmSyncEvent => o.kind === 'crm-sync-event',
    );
    if (events.length === 0) return null; // no CRM event -> this blocker is not applicable
    const noteOnly = events.filter((e) => e.syncedFieldCount <= 0);
    return noteOnly.length > 0
      ? `CRM sync without structured fields (note only): ${noteOnly
          .map((e) => e.id)
          .join(', ')}.`
      : null;
  },

  // "no distinction between sales/proposal/install grade".
  'no-approval-grade-distinction': (a) => {
    const approvals = a.objects.filter(
      (o): o is Approval => o.kind === 'approval',
    );
    if (approvals.length === 0) {
      return 'No approval object — sales/proposal/install grade not distinguished.';
    }
    return null;
  },
};

// ───────────────────────────────────────────────────────────────────────────
// evaluateArtifact — the deterministic core function (N6).
// ───────────────────────────────────────────────────────────────────────────

export function evaluateArtifact(
  artifact: PvArtifact,
  testCase: PvEvalTestCase,
): EvalVerdict {
  const presentKinds = presentObjectKinds(artifact);
  const presentDecisions = new Set(artifact.expertDecisions);

  const missingObjects = testCase.requiredDomainObjects.filter(
    (k) => !presentKinds.has(k),
  );
  const missingDecisions = testCase.requiredExpertDecisions.filter(
    (d) => !presentDecisions.has(d),
  );

  const trippedBlockers: { blocker: BlockerId; reason: string }[] = [];
  for (const blocker of testCase.blockerIf) {
    const reason = BLOCKER_DETECTORS[blocker](artifact);
    if (reason) trippedBlockers.push({ blocker, reason });
  }

  const passed =
    missingObjects.length === 0 &&
    missingDecisions.length === 0 &&
    trippedBlockers.length === 0;

  return {
    testCaseId: testCase.id,
    passed,
    missingObjects,
    missingDecisions,
    trippedBlockers,
  };
}

/**
 * Convenience batch runner: evaluates one artifact against multiple cases.
 */
export function evaluateArtifactAgainstCases(
  artifact: PvArtifact,
  cases: readonly PvEvalTestCase[],
): EvalVerdict[] {
  return cases.map((c) => evaluateArtifact(artifact, c));
}

// ───────────────────────────────────────────────────────────────────────────
// Integration with quality gate G5 (domain depth).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Translates a verdict into a `QualityGateResult` so the Demo PV eval can be
 * consumed as a G5 domain-depth proof in the portfolio spine. A `passed`
 * verdict -> gate passed; otherwise the missing items as blockingItems
 * (owner-/critic-readable).
 */
export function toG5GateResult(verdict: EvalVerdict): QualityGateResult {
  if (verdict.passed) {
    return {
      passed: true,
      reason: `Demo PV eval "${verdict.testCaseId}" passed — domain model + expert decisions compiled.`,
      blockingItems: [],
    };
  }
  const blockingItems = [
    ...verdict.missingObjects.map((o) => `missing-object:${o}`),
    ...verdict.missingDecisions.map((d) => `missing-decision:${d}`),
    ...verdict.trippedBlockers.map((b) => `blocker:${b.blocker}`),
  ];
  return {
    passed: false,
    reason: `Demo PV eval "${verdict.testCaseId}" failed (anti-MVP gate): ${blockingItems.length} open items.`,
    blockingItems,
  };
}
