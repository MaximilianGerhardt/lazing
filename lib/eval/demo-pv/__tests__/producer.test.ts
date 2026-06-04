/**
 * Demo PV (photovoltaic) regression eval · Producer tests
 *
 * Checks `producer.ts`:
 *   (a) Valid producer output satisfies the ALREADY-CODED rule
 *       `stringingViolations` (0 violations) — pure physics against the rule.
 *   (b) The generated artifact through `from-artifact.ts` → `evaluate.ts` makes
 *       `only-roof-drawer` + `no-electrical-model` NO longer trigger:
 *       G5 BLOCK → PASS (verified via toG5GateResult).
 *   (c) install grade without expertReviewed → human-decision gate payload.
 *   (d) Missing inputs → honestly empty (no guessing), with a verbatim reason.
 *
 * Run:
 *   pnpm vitest run lib/eval/demo-pv/__tests__/producer.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  stringingViolations,
  type Building,
  type Inverter,
  type PvModule,
  type Quote,
  type RoofPlane,
  type SimulationRun,
  type Approval,
} from '@/lib/eval/demo-pv/domain-model';
import { evaluateArtifact, toG5GateResult } from '@/lib/eval/demo-pv/evaluate';
import {
  mapArtifactToPvArtifact,
  type GenericBuildArtifact,
} from '@/lib/eval/demo-pv/from-artifact';
import {
  buildExpertReviewGate,
  feasibleModuleCountRange,
  produceStringingPlan,
  vocAtTmin,
  vmpAtTmax,
  DEFAULT_T_MIN_C,
  DEFAULT_T_MAX_C,
  DEFAULT_VMP_TEMP_COEFF_PCT_PER_C,
} from '@/lib/eval/demo-pv/producer';
import { getTestCase } from '@/lib/eval/demo-pv/test-cases';

// ───────────────────────────────────────────────────────────────────────────
// Given hardware (NOT invented by the producer) — analogous to evaluate.test.ts.
// ───────────────────────────────────────────────────────────────────────────

function givenModule(): PvModule {
  return {
    kind: 'module',
    id: 'mod-1',
    manufacturer: 'Acme',
    model: 'AC-440',
    wattPeak: 440,
    vocStc: 38.5,
    vmpStc: 32.0,
    tempCoeffVocPctPerC: -0.27,
  };
}

function givenInverter(): Inverter {
  return {
    kind: 'inverter',
    id: 'inv-1',
    manufacturer: 'Acme',
    model: 'AC-5K',
    acNominalPowerW: 5000,
    maxDcPowerW: 7500,
    maxDcVoltageV: 600,
    mpptTrackers: 2,
    mpptVoltageWindowV: { min: 120, max: 500 },
  };
}

function givenRoofPlane(overrides: Partial<RoofPlane> = {}): RoofPlane {
  return {
    kind: 'roof-plane',
    id: 'rp-1',
    buildingId: 'bld-1',
    azimuthDeg: 180,
    tiltDeg: 35,
    areaM2: 40,
    usableAreaM2: 34,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (a) Valid output satisfies the coded stringing rule
// ───────────────────────────────────────────────────────────────────────────

describe('produceStringingPlan — physics against the coded rule', () => {
  it('generates at least one string and 0 stringingViolations', () => {
    const result = produceStringingPlan({
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter: givenInverter(),
    });

    expect(result.strings.length).toBeGreaterThan(0);
    // Producer self-verification …
    expect(result.ruleViolations).toEqual([]);
    // … and independently again directly against the REAL rule from domain-model.ts.
    const direct = stringingViolations({
      objects: [givenInverter(), ...result.strings],
      expertDecisions: [],
    });
    expect(direct).toEqual([]);
  });

  it('every string stays below maxDcVoltage (cold) and within the MPPT window (hot)', () => {
    const inverter = givenInverter();
    const result = produceStringingPlan({
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter,
    });
    for (const s of result.strings) {
      expect(s.voltageWindowV.vocAtTmin).toBeLessThanOrEqual(inverter.maxDcVoltageV);
      expect(s.voltageWindowV.vmpAtTmax).toBeGreaterThanOrEqual(
        inverter.mpptVoltageWindowV.min,
      );
      expect(s.voltageWindowV.vmpAtTmax).toBeLessThanOrEqual(
        inverter.mpptVoltageWindowV.max,
      );
      // mpptInputIndex must be within [0, mpptTrackers).
      expect(s.mpptInputIndex).toBeGreaterThanOrEqual(0);
      expect(s.mpptInputIndex).toBeLessThan(inverter.mpptTrackers);
    }
  });

  it('is deterministic (idempotent): two runs yield identical strings', () => {
    const args = {
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter: givenInverter(),
    };
    expect(produceStringingPlan(args).strings).toEqual(
      produceStringingPlan(args).strings,
    );
  });

  it('feasibleModuleCountRange + temperature helpers compute the expected physics', () => {
    const range = feasibleModuleCountRange(
      givenModule(),
      givenInverter(),
      DEFAULT_T_MIN_C,
      DEFAULT_T_MAX_C,
      DEFAULT_VMP_TEMP_COEFF_PCT_PER_C,
    );
    expect(range).toEqual({ min: 5, max: 14 });
    // Uoc rises in the cold; at 14 modules just under 600V.
    expect(vocAtTmin(givenModule(), 14, DEFAULT_T_MIN_C)).toBeLessThanOrEqual(600);
    expect(vocAtTmin(givenModule(), 15, DEFAULT_T_MIN_C)).toBeGreaterThan(600);
    // Umpp drops in the heat; at 14 modules within the window.
    const u = vmpAtTmax(givenModule(), 14, DEFAULT_T_MAX_C, DEFAULT_VMP_TEMP_COEFF_PCT_PER_C);
    expect(u).toBeGreaterThanOrEqual(120);
    expect(u).toBeLessThanOrEqual(500);
  });

  it('distributes multiple strings round-robin across the MPPT trackers', () => {
    // Two roof planes with ample layout → multiple strings on both trackers.
    const result = produceStringingPlan({
      roofPlanes: [
        givenRoofPlane({ id: 'rp-a' }),
        givenRoofPlane({ id: 'rp-b' }),
      ],
      module: givenModule(),
      inverter: givenInverter(),
      modulesPerPlane: { 'rp-a': 28, 'rp-b': 28 },
    });
    expect(result.strings.length).toBeGreaterThanOrEqual(2);
    const usedTrackers = new Set(result.strings.map((s) => s.mpptInputIndex));
    expect(usedTrackers.size).toBe(2);
    expect(result.ruleViolations).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) G5 BLOCK → PASS über from-artifact.ts → evaluate.ts
// ───────────────────────────────────────────────────────────────────────────

/**
 * Builds an "only roof drawer" remainder package around the producer output
 * (building+roof plane+lead+sim+quote+approval) so the simple-roof case is
 * fully satisfiable — the producer's decisive contribution is
 * `inverters[]` + `strings[]`.
 */
function packageAroundProducer(producerArtifact: GenericBuildArtifact): GenericBuildArtifact {
  const building: Building = {
    kind: 'building',
    id: 'bld-1',
    leadId: 'lead-1',
    roofType: 'gable',
    roofPlaneCount: 1,
    roofCovering: 'clay tile',
    eaveHeightM: 6,
    structuralCheckDone: true,
  };
  const sim: SimulationRun = {
    kind: 'simulation-run',
    id: 'sim-1',
    buildingId: 'bld-1',
    inputStringIds: ['str-1'],
    annualYieldKwh: 5200,
    selfConsumptionRatio: 0.35,
    autarkyRatio: 0.55,
    specificYieldKwhPerKwp: 985,
  };
  const quote: Quote = {
    kind: 'quote',
    id: 'q-1',
    leadId: 'lead-1',
    netTotalEur: 14500,
    lineItemCount: 8,
    paybackYears: 11,
    requiresApprovalGrade: 'proposal',
  };
  const approval: Approval = {
    kind: 'approval',
    id: 'ap-1',
    quoteId: 'q-1',
    grade: 'proposal',
    expertReviewed: true,
    reviewerRole: 'pv-planner',
  };
  const sp = producerArtifact.surfacePayload ?? {};
  return {
    surfacePayload: {
      lead: {
        id: 'lead-1',
        source: 'web-form',
        addressLine: 'Example Street 1',
        postalCode: '12345',
        isPropertyOwner: true,
        annualConsumptionKwhEstimate: 4500,
      },
      building,
      roofPlanes: [givenRoofPlane()],
      modules: [givenModule()],
      // ← the producer's contribution (the missing electrical model):
      inverters: sp.inverters,
      strings: sp.strings,
      simulation: sim,
      quote,
      approval,
    },
    decisions: [{ decisionId: 'stringing-validated' }, { kind: 'yield-simulated' }],
  };
}

describe('Producer → from-artifact → evaluate: G5 BLOCK→PASS', () => {
  it('without producer: only roof drawer → G5 BLOCK (only-roof-drawer + no-electrical-model)', () => {
    const pv = mapArtifactToPvArtifact({
      surfacePayload: {
        building: {
          id: 'bld-1',
          leadId: 'lead-1',
          roofType: 'gable',
          roofPlaneCount: 1,
          roofCovering: 'clay tile',
          eaveHeightM: 6,
          structuralCheckDone: true,
        },
        roofPlanes: [givenRoofPlane()],
      },
    });
    const verdict = evaluateArtifact(pv, getTestCase('simple-roof'));
    const gate = toG5GateResult(verdict);
    expect(gate.passed).toBe(false); // BLOCK
    const tripped = verdict.trippedBlockers.map((b) => b.blocker);
    expect(tripped).toContain('only-roof-drawer');
    expect(tripped).toContain('no-electrical-model');
  });

  it('with producer: the same blockers NO longer trigger → G5 PASS', () => {
    const produced = produceStringingPlan({
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter: givenInverter(),
    });
    expect(produced.strings.length).toBeGreaterThan(0);

    const pv = mapArtifactToPvArtifact(packageAroundProducer(produced.artifact));

    // The two previously blocking detectors no longer fire.
    const verdict = evaluateArtifact(pv, getTestCase('simple-roof'));
    const tripped = verdict.trippedBlockers.map((b) => b.blocker);
    expect(tripped).not.toContain('only-roof-drawer');
    expect(tripped).not.toContain('no-electrical-model');
    expect(tripped).not.toContain('stringing-rule-violated');

    // And the G5 gate flips from BLOCK to PASS.
    const gate = toG5GateResult(verdict);
    expect(verdict.passed).toBe(true);
    expect(gate.passed).toBe(true);
    expect(gate.blockingItems).toEqual([]);
  });

  it('also passes the dedicated stringing-constraint case', () => {
    const produced = produceStringingPlan({
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter: givenInverter(),
    });
    const pv = mapArtifactToPvArtifact({
      surfacePayload: {
        modules: [givenModule()],
        inverters: produced.artifact.surfacePayload?.inverters,
        strings: produced.artifact.surfacePayload?.strings,
      },
      decisions: [{ decisionId: 'stringing-validated' }],
    });
    const verdict = evaluateArtifact(pv, getTestCase('stringing-constraint'));
    expect(verdict.passed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) Expert gate
// ───────────────────────────────────────────────────────────────────────────

describe('buildExpertReviewGate — install grade without expertReviewed', () => {
  it('generates a human-decision gate when install grade is requested without review', () => {
    const gate = buildExpertReviewGate({
      requestedGrade: 'install',
      expertReviewed: false,
      quoteId: 'q-1',
      approvalId: 'ap-1',
    });
    expect(gate).not.toBeNull();
    expect(gate!.kind).toBe('human-decision');
    expect(gate!.gateId).toBe('expert-review-install-grade');
    expect(gate!.quoteId).toBe('q-1');
    expect(gate!.approvalId).toBe('ap-1');
    // The decisions required by the eval blocker expert-review-optional + the
    // expert-gate case.
    expect(gate!.grantsDecisionsOnApprove).toContain('expert-reviewed');
    expect(gate!.grantsDecisionsOnApprove).toContain('statics-checked');
    expect(gate!.setsFieldOnApprove).toEqual({
      object: 'approval',
      field: 'expertReviewed',
      value: true,
    });
    expect(gate!.reviewItems.length).toBeGreaterThan(0);
  });

  it('NO gate when already expertReviewed', () => {
    expect(
      buildExpertReviewGate({ requestedGrade: 'install', expertReviewed: true }),
    ).toBeNull();
  });

  it('NO gate for sales/proposal grade', () => {
    expect(
      buildExpertReviewGate({ requestedGrade: 'sales', expertReviewed: false }),
    ).toBeNull();
    expect(
      buildExpertReviewGate({ requestedGrade: 'proposal', expertReviewed: false }),
    ).toBeNull();
  });

  it('gate approve clears expert-review-optional in the eval (integration proof)', () => {
    const gate = buildExpertReviewGate({
      requestedGrade: 'install',
      expertReviewed: false,
      quoteId: 'q-1',
      approvalId: 'ap-1',
    })!;
    // Simulate the approve effect wired up by the UI path: set the field + harvest decisions.
    const approval: Approval = {
      kind: 'approval',
      id: 'ap-1',
      quoteId: 'q-1',
      grade: 'install',
      expertReviewed: true, // ← gate.setsFieldOnApprove
      reviewerRole: 'pv-expert',
    };
    const building: Building = {
      kind: 'building',
      id: 'bld-1',
      leadId: 'lead-1',
      roofType: 'gable',
      roofPlaneCount: 1,
      roofCovering: 'clay tile',
      eaveHeightM: 6,
      structuralCheckDone: true,
    };
    const quote: Quote = {
      kind: 'quote',
      id: 'q-1',
      leadId: 'lead-1',
      netTotalEur: 14500,
      lineItemCount: 8,
      paybackYears: 11,
      requiresApprovalGrade: 'install',
    };
    const verdict = evaluateArtifact(
      {
        objects: [building, quote, approval],
        expertDecisions: gate.grantsDecisionsOnApprove, // ← harvested
      },
      getTestCase('expert-gate'),
    );
    expect(verdict.trippedBlockers.map((b) => b.blocker)).not.toContain(
      'expert-review-optional',
    );
    expect(verdict.passed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d) Missing inputs → honestly empty, no guessing
// ───────────────────────────────────────────────────────────────────────────

describe('produceStringingPlan — honestly empty, no guessing', () => {
  it('no roof plane → 0 strings + verbatim reason, empty artifact', () => {
    const result = produceStringingPlan({
      roofPlanes: [],
      module: givenModule(),
      inverter: givenInverter(),
    });
    expect(result.strings).toEqual([]);
    expect(result.artifact.surfacePayload?.strings).toEqual([]);
    expect(result.artifact.surfacePayload?.inverters).toEqual([]);
    expect(result.omissions.length).toBeGreaterThan(0);
    expect(result.omissions[0].reason).toMatch(/No roof plane/);
  });

  it('roof plane without layout info (no usableAreaM2, no modulesPerPlane) → omitted, not guessed', () => {
    const result = produceStringingPlan({
      roofPlanes: [givenRoofPlane({ usableAreaM2: 0 })],
      module: givenModule(),
      inverter: givenInverter(),
    });
    expect(result.strings).toEqual([]);
    expect(result.omissions.some((o) => o.roofPlaneId === 'rp-1')).toBe(true);
  });

  it('unsolvable module/inverter combination → 0 strings + reason (no forced string)', () => {
    // Inverter with an absurdly low maxDc → even 1 module blows the limit.
    const tinyInverter: Inverter = { ...givenInverter(), maxDcVoltageV: 10 };
    const result = produceStringingPlan({
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter: tinyInverter,
    });
    expect(result.strings).toEqual([]);
    expect(result.omissions.length).toBeGreaterThan(0);
    expect(result.ruleViolations).toEqual([]); // empty model → no violation
  });

  it('makes implicit defaults visible (assumptions) instead of hiding them', () => {
    const result = produceStringingPlan({
      roofPlanes: [givenRoofPlane()],
      module: givenModule(),
      inverter: givenInverter(),
    });
    const fields = result.assumptions.map((a) => a.field);
    expect(fields).toContain('vmpTempCoeffPctPerC');
    expect(fields).toContain('tMinC');
    expect(fields).toContain('tMaxC');
  });

  it('an omitted plane generates NO below-MPPT partial string from leftover modules', () => {
    // Capacity exactly between 1× and 2× perString, remainder < range.min.
    const result = produceStringingPlan({
      roofPlanes: [givenRoofPlane({ id: 'rp-x' })],
      module: givenModule(),
      inverter: givenInverter(),
      modulesPerPlane: { 'rp-x': 16 }, // perString=14, remainder=2 (<5) → no remainder string
    });
    expect(result.strings).toHaveLength(1);
    expect(result.strings[0].moduleCount).toBe(14);
    expect(result.omissions.some((o) => /Remaining capacity/.test(o.reason))).toBe(true);
    expect(result.ruleViolations).toEqual([]);
  });
});
