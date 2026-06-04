/**
 * Demo PV (photovoltaic) regression eval · Tests
 *
 * Strategy: pure deterministic unit tests (N6), no DB needed.
 *   (a) A complete PV package fixture passes all applicable cases.
 *   (b) An "only roof drawer without stringing" fixture FAILS at the blocker.
 *   (c) Each of the 8 test cases is well-formed.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/eval/demo-pv
 */

import { describe, expect, it } from 'vitest';

import {
  DOMAIN_OBJECT_KINDS,
  type Building,
  type DomainObject,
  type Inverter,
  type Lead,
  type PvArtifact,
  type PvModule,
  type PvString,
  type Quote,
  type RoofPlane,
  type SimulationRun,
  type Approval,
} from '@/lib/eval/demo-pv/domain-model';
import { evaluateArtifact } from '@/lib/eval/demo-pv/evaluate';
import {
  BLOCKER_IDS,
  PV_EVAL_TEST_CASES,
  getTestCase,
} from '@/lib/eval/demo-pv/test-cases';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

/**
 * A complete, domain-correct PV package for the simple-roof case:
 * south gable roof, 12 modules in series, valid stringing within the
 * inverter DC window + MPPT window, simulation, quote, proposal approval.
 */
function completePvPackage(): PvArtifact {
  const lead: Lead = {
    kind: 'lead',
    id: 'lead-1',
    source: 'web-form',
    addressLine: 'Example Street 1',
    postalCode: '12345',
    isPropertyOwner: true,
    annualConsumptionKwhEstimate: 4500,
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
  const roof: RoofPlane = {
    kind: 'roof-plane',
    id: 'rp-1',
    buildingId: 'bld-1',
    azimuthDeg: 180,
    tiltDeg: 35,
    areaM2: 40,
    usableAreaM2: 34,
  };
  const mod: PvModule = {
    kind: 'module',
    id: 'mod-1',
    manufacturer: 'Acme',
    model: 'AC-440',
    wattPeak: 440,
    vocStc: 38.5,
    vmpStc: 32.0,
    tempCoeffVocPctPerC: -0.27,
  };
  const inverter: Inverter = {
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
  // 12 modules in series -> Uoc(Tmin)≈12*~42=~504V < 600V; Umpp(Tmax)≈12*~30=~360V in [120,500].
  const str: PvString = {
    kind: 'string',
    id: 'str-1',
    roofPlaneId: 'rp-1',
    moduleId: 'mod-1',
    moduleCount: 12,
    inverterId: 'inv-1',
    mpptInputIndex: 0,
    voltageWindowV: { vocAtTmin: 504, vmpAtTmax: 360 },
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

  return {
    objects: [lead, building, roof, mod, inverter, str, sim, quote, approval],
    expertDecisions: [
      'stringing-validated',
      'yield-simulated',
      'multi-plane-layout',
      'shading-assessed',
    ],
  };
}

/** Pure roof-drawer artifact: building + roof plane, NO electrics. */
function roofDrawerOnly(): PvArtifact {
  const objects: DomainObject[] = [
    {
      kind: 'building',
      id: 'bld-x',
      leadId: 'lead-x',
      roofType: 'gable',
      roofPlaneCount: 1,
      roofCovering: 'tile',
      eaveHeightM: 5,
      structuralCheckDone: false,
    },
    {
      kind: 'roof-plane',
      id: 'rp-x',
      buildingId: 'bld-x',
      azimuthDeg: 180,
      tiltDeg: 30,
      areaM2: 30,
      usableAreaM2: 25,
    },
  ];
  return { objects, expertDecisions: [] };
}

// ───────────────────────────────────────────────────────────────────────────
// (a) Complete package passes
// ───────────────────────────────────────────────────────────────────────────

describe('evaluateArtifact — complete PV package', () => {
  it('passes the simple-roof case', () => {
    const verdict = evaluateArtifact(completePvPackage(), getTestCase('simple-roof'));
    expect(verdict.missingObjects).toEqual([]);
    expect(verdict.missingDecisions).toEqual([]);
    expect(verdict.trippedBlockers).toEqual([]);
    expect(verdict.passed).toBe(true);
  });

  it('passes the stringing-constraint case (valid voltage window)', () => {
    const verdict = evaluateArtifact(
      completePvPackage(),
      getTestCase('stringing-constraint'),
    );
    expect(verdict.passed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) Roof-drawer-only fails at the blocker
// ───────────────────────────────────────────────────────────────────────────

describe('evaluateArtifact — anti-MVP blocker', () => {
  it('FAILS the simple-roof case (only roof drawer, no stringing)', () => {
    const verdict = evaluateArtifact(roofDrawerOnly(), getTestCase('simple-roof'));
    expect(verdict.passed).toBe(false);

    const tripped = verdict.trippedBlockers.map((b) => b.blocker);
    // Core blockers of the verbatim criterion: only roof drawer + no electrical model.
    expect(tripped).toContain('only-roof-drawer');
    expect(tripped).toContain('no-electrical-model');
    // And electrical objects are missing.
    expect(verdict.missingObjects).toContain('string');
    expect(verdict.missingObjects).toContain('inverter');
  });

  it('FAILS with a violated stringing voltage window', () => {
    const pkg = completePvPackage();
    // Push the string over the inverter DC limit.
    const str = pkg.objects.find((o) => o.kind === 'string') as PvString;
    str.voltageWindowV.vocAtTmin = 720; // > maxDcVoltage 600
    const verdict = evaluateArtifact(pkg, getTestCase('stringing-constraint'));
    expect(verdict.passed).toBe(false);
    expect(verdict.trippedBlockers.map((b) => b.blocker)).toContain(
      'stringing-rule-violated',
    );
  });

  it('FAILS at the expert gate when an install approval has no review', () => {
    const pkg = completePvPackage();
    const ap = pkg.objects.find((o) => o.kind === 'approval') as Approval;
    ap.grade = 'install';
    ap.expertReviewed = false;
    pkg.expertDecisions = []; // no statics-checked/expert-reviewed
    const verdict = evaluateArtifact(pkg, getTestCase('expert-gate'));
    expect(verdict.passed).toBe(false);
    expect(verdict.trippedBlockers.map((b) => b.blocker)).toContain(
      'expert-review-optional',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) All 8 test cases are well-formed
// ───────────────────────────────────────────────────────────────────────────

describe('PV_EVAL_TEST_CASES — well-formedness', () => {
  it('contains exactly the 8 expected cases', () => {
    expect(PV_EVAL_TEST_CASES).toHaveLength(8);
    expect(PV_EVAL_TEST_CASES.map((c) => c.id).sort()).toEqual(
      [
        'bad-automation',
        'complex-roof',
        'crm-handoff',
        'expert-gate',
        'simple-roof',
        'storage-sizing',
        'stringing-constraint',
        'tool-replacement',
      ].sort(),
    );
  });

  it.each(PV_EVAL_TEST_CASES.map((c) => [c.id, c] as const))(
    'case %s is well-formed',
    (_id, c) => {
      // Intent is a non-empty owner prompt.
      expect(c.intent.length).toBeGreaterThan(10);
      // At least 1 required domain object, all from the 13-kind canon.
      expect(c.requiredDomainObjects.length).toBeGreaterThan(0);
      for (const k of c.requiredDomainObjects) {
        expect(DOMAIN_OBJECT_KINDS).toContain(k);
      }
      // At least 1 expert decision.
      expect(c.requiredExpertDecisions.length).toBeGreaterThan(0);
      // At least 1 blocker, all from the blocker canon.
      expect(c.blockerIf.length).toBeGreaterThan(0);
      for (const b of c.blockerIf) {
        expect(BLOCKER_IDS).toContain(b);
      }
    },
  );

  it('every blocker-canon entry is armed by at least one case', () => {
    const used = new Set(PV_EVAL_TEST_CASES.flatMap((c) => c.blockerIf));
    for (const b of BLOCKER_IDS) {
      expect(used.has(b)).toBe(true);
    }
  });
});
