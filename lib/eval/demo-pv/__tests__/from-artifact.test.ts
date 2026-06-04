/**
 * Demo PV (photovoltaic) regression eval · Adapter tests
 *
 * Checks `mapArtifactToPvArtifact` (from-artifact.ts):
 *   (a) Complete surface/decision output → complete PvArtifact that
 *       evaluateArtifact PASSES against simple-roof.
 *   (b) "Only roof drawer" output (building+roof plane, NO electrics) → maps
 *       to an artifact without string/inverter → fails at the blocker.
 *   (c) Defensive: null/empty/broken input → empty artifact, no crash.
 *   (d) Decisions from multiple sources are unioned + deduplicated.
 *
 * Run:
 *   pnpm vitest run lib/eval/demo-pv/__tests__/from-artifact.test.ts
 */

import { describe, expect, it } from 'vitest';

import { evaluateArtifact } from '@/lib/eval/demo-pv/evaluate';
import {
  mapArtifactToPvArtifact,
  type GenericBuildArtifact,
} from '@/lib/eval/demo-pv/from-artifact';
import { getTestCase } from '@/lib/eval/demo-pv/test-cases';

// ───────────────────────────────────────────────────────────────────────────
// Generic build outputs (as a real lane would produce them)
// ───────────────────────────────────────────────────────────────────────────

/** A complete PV package as a surface payload + decisions (simple-roof). */
function completeBuildArtifact(): GenericBuildArtifact {
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
      building: {
        id: 'bld-1',
        leadId: 'lead-1',
        roofType: 'gable',
        roofPlaneCount: 1,
        roofCovering: 'clay tile',
        eaveHeightM: 6,
        structuralCheckDone: true,
      },
      roofPlanes: [
        {
          id: 'rp-1',
          buildingId: 'bld-1',
          azimuthDeg: 180,
          tiltDeg: 35,
          areaM2: 40,
          usableAreaM2: 34,
        },
      ],
      modules: [
        {
          id: 'mod-1',
          manufacturer: 'Acme',
          model: 'AC-440',
          wattPeak: 440,
          vocStc: 38.5,
          vmpStc: 32.0,
          tempCoeffVocPctPerC: -0.27,
        },
      ],
      inverters: [
        {
          id: 'inv-1',
          manufacturer: 'Acme',
          model: 'AC-5K',
          acNominalPowerW: 5000,
          maxDcPowerW: 7500,
          maxDcVoltageV: 600,
          mpptTrackers: 2,
          mpptVoltageWindowV: { min: 120, max: 500 },
        },
      ],
      strings: [
        {
          id: 'str-1',
          roofPlaneId: 'rp-1',
          moduleId: 'mod-1',
          moduleCount: 12,
          inverterId: 'inv-1',
          mpptInputIndex: 0,
          voltageWindowV: { vocAtTmin: 504, vmpAtTmax: 360 },
        },
      ],
      simulation: {
        id: 'sim-1',
        buildingId: 'bld-1',
        inputStringIds: ['str-1'],
        annualYieldKwh: 5200,
        selfConsumptionRatio: 0.35,
        autarkyRatio: 0.55,
        specificYieldKwhPerKwp: 985,
      },
      quote: {
        id: 'q-1',
        leadId: 'lead-1',
        netTotalEur: 14500,
        lineItemCount: 8,
        paybackYears: 11,
        requiresApprovalGrade: 'proposal',
      },
      approval: {
        id: 'ap-1',
        quoteId: 'q-1',
        grade: 'proposal',
        expertReviewed: true,
        reviewerRole: 'pv-planner',
      },
    },
    decisions: [
      { decisionId: 'stringing-validated' },
      { kind: 'yield-simulated' },
    ],
    flowSteps: [
      { status: 'done', decisionId: 'multi-plane-layout' },
      { status: 'done', decisionId: 'shading-assessed' },
    ],
  };
}

/** "Only roof drawer": building + roof plane, NO electrics, NO decisions. */
function roofDrawerOnlyArtifact(): GenericBuildArtifact {
  return {
    surfacePayload: {
      building: {
        id: 'bld-x',
        leadId: 'lead-x',
        roofType: 'gable',
        roofPlaneCount: 1,
        roofCovering: 'tile',
        eaveHeightM: 5,
        structuralCheckDone: false,
      },
      roofPlanes: [
        {
          id: 'rp-x',
          buildingId: 'bld-x',
          azimuthDeg: 180,
          tiltDeg: 30,
          areaM2: 30,
          usableAreaM2: 25,
        },
      ],
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (a) Complete output → passes simple-roof
// ───────────────────────────────────────────────────────────────────────────

describe('mapArtifactToPvArtifact — complete output', () => {
  it('maps surface+decisions onto a complete PvArtifact', () => {
    const pv = mapArtifactToPvArtifact(completeBuildArtifact());
    const kinds = new Set(pv.objects.map((o) => o.kind));
    for (const k of [
      'lead',
      'building',
      'roof-plane',
      'module',
      'string',
      'inverter',
      'simulation-run',
      'quote',
      'approval',
    ] as const) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(pv.expertDecisions).toContain('stringing-validated');
    expect(pv.expertDecisions).toContain('yield-simulated');
  });

  it('passes the simple-roof case after mapping', () => {
    const pv = mapArtifactToPvArtifact(completeBuildArtifact());
    const verdict = evaluateArtifact(pv, getTestCase('simple-roof'));
    expect(verdict.missingObjects).toEqual([]);
    expect(verdict.missingDecisions).toEqual([]);
    expect(verdict.trippedBlockers).toEqual([]);
    expect(verdict.passed).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (b) Roof-drawer-only → fails
// ───────────────────────────────────────────────────────────────────────────

describe('mapArtifactToPvArtifact — anti-MVP (only roof drawer)', () => {
  it('maps to an artifact WITHOUT an electrical model', () => {
    const pv = mapArtifactToPvArtifact(roofDrawerOnlyArtifact());
    const kinds = new Set(pv.objects.map((o) => o.kind));
    expect(kinds.has('building')).toBe(true);
    expect(kinds.has('roof-plane')).toBe(true);
    expect(kinds.has('string')).toBe(false);
    expect(kinds.has('inverter')).toBe(false);
    expect(pv.expertDecisions).toEqual([]);
  });

  it('FAILS the simple-roof case (only-roof-drawer + no-electrical-model)', () => {
    const pv = mapArtifactToPvArtifact(roofDrawerOnlyArtifact());
    const verdict = evaluateArtifact(pv, getTestCase('simple-roof'));
    expect(verdict.passed).toBe(false);
    const tripped = verdict.trippedBlockers.map((b) => b.blocker);
    expect(tripped).toContain('only-roof-drawer');
    expect(tripped).toContain('no-electrical-model');
    expect(verdict.missingObjects).toContain('string');
    expect(verdict.missingObjects).toContain('inverter');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (c) Defensive / fail-soft
// ───────────────────────────────────────────────────────────────────────────

describe('mapArtifactToPvArtifact — fail-soft', () => {
  it('null/undefined → empty artifact, no crash', () => {
    expect(mapArtifactToPvArtifact(null)).toEqual({
      objects: [],
      expertDecisions: [],
    });
    expect(mapArtifactToPvArtifact(undefined)).toEqual({
      objects: [],
      expertDecisions: [],
    });
  });

  it('non-object input → empty artifact', () => {
    expect(
      mapArtifactToPvArtifact('nonsense' as unknown as GenericBuildArtifact),
    ).toEqual({ objects: [], expertDecisions: [] });
  });

  it('discards objects with an unknown kind / missing id', () => {
    const pv = mapArtifactToPvArtifact({
      domainObjects: [
        { kind: 'bogus', id: 'x' },
        { kind: 'lead' }, // no id
        { kind: 'inverter', id: 'inv-ok', mpptTrackers: 2 },
      ],
    });
    const kinds = pv.objects.map((o) => o.kind);
    expect(kinds).toEqual(['inverter']);
  });

  it('empty object → empty artifact (leads to blocker hits in the eval)', () => {
    const pv = mapArtifactToPvArtifact({});
    expect(pv.objects).toEqual([]);
    expect(pv.expertDecisions).toEqual([]);
  });

  it('ignores not-yet-completed flow steps for object contribution', () => {
    const pv = mapArtifactToPvArtifact({
      flowSteps: [
        {
          status: 'running',
          outputs: { inverters: [{ id: 'inv-pending' }] },
        },
      ],
    });
    expect(pv.objects).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (d) Decision dedupe + multi-source
// ───────────────────────────────────────────────────────────────────────────

describe('mapArtifactToPvArtifact — decision union', () => {
  it('unions + deduplicates decisions from decisions[] + flowSteps[]', () => {
    const pv = mapArtifactToPvArtifact({
      decisions: [{ decisionId: 'stringing-validated' }, 'expert-reviewed'],
      flowSteps: [
        { status: 'done', decisionId: 'stringing-validated' }, // duplicate
        { status: 'done', decisionId: 'yield-simulated' },
      ],
    });
    expect(pv.expertDecisions.sort()).toEqual(
      ['expert-reviewed', 'stringing-validated', 'yield-simulated'].sort(),
    );
  });

  it('deduplicates objects by kind+id across multiple sources', () => {
    const obj = { id: 'inv-1', mpptTrackers: 2 };
    const pv = mapArtifactToPvArtifact({
      domainObjects: [{ kind: 'inverter', ...obj }],
      surfacePayload: { inverters: [obj] },
    });
    expect(pv.objects.filter((o) => o.kind === 'inverter')).toHaveLength(1);
  });
});
