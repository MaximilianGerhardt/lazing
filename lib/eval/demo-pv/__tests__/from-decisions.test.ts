/**
 * Demo PV (photovoltaic) eval · from-decisions (LIVE hop) tests
 * ════════════════════════════════════════════════════════════════════════
 *
 * Proves the adapter that turns the pv-stringing producer output from persisted
 * `workstream_decisions.rationale` strings back into a domain-eval context —
 * the missing bridge between the (in-flow persisted) producer output and
 * `state.domainEval.pvArtifact` (G5).
 *
 * Important: this test uses EXACTLY the same producer output as the real flow,
 * by calling `runPvStringingStep` (source of truth of the marker format) and
 * embedding its text into a decision rationale — as plan-executor.ts does.
 *
 * Run:
 *   pnpm vitest run lib/eval/demo-pv/__tests__/from-decisions.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  type Approval,
  type Building,
  type Inverter,
  type PvModule,
  type Quote,
  type RoofPlane,
  type SimulationRun,
} from '@/lib/eval/demo-pv/domain-model';
import { evaluateArtifact } from '@/lib/eval/demo-pv/evaluate';
import {
  DEFAULT_PV_TEST_CASE_ID,
  PV_STRINGING_ARTIFACT_OPEN,
  PV_STRINGING_DECISION_PREFIX,
  buildPvDomainEvalFromDecisions,
  mergeBuildArtifacts,
  parsePvStringingArtifactBlock,
  pickTestCaseForArtifact,
} from '@/lib/eval/demo-pv/from-decisions';
import {
  mapArtifactToPvArtifact,
  type GenericBuildArtifact,
} from '@/lib/eval/demo-pv/from-artifact';
import { getTestCase } from '@/lib/eval/demo-pv/test-cases';
import {
  PV_STRINGING_OUTPUT_MARKER,
  runPvStringingStep,
} from '@/lib/workstreams/plan-executor';
import type { WorkstreamPlanStepRow } from '@/db/schema/workstream_plan_steps';

// ───────────────────────────────────────────────────────────────────────────
// Given hardware (identical to producer.test.ts / wiring.test.ts).
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

function makeStep(config: Record<string, unknown> | null): WorkstreamPlanStepRow {
  const annotation = {
    flowStepId: 'FS-1',
    skill: 'pv-stringing',
    toolKind: null,
    connectorId: null,
    configJson: config != null ? JSON.stringify(config) : null,
  };
  return {
    id: 'STEP-1',
    workstreamId: 'WS-1',
    planId: 'PLAN-1',
    parentStepId: null,
    stepIndex: 0,
    title: 'PV stringing layout',
    rationale: `PV stringing | flow:${JSON.stringify(annotation)}`,
    subagentRole: 'coder',
    targetFilesJson: null,
    expectedArtifactsJson: null,
    depth: 0,
    coordKey: 'ws:WS-1',
    allowedTools: null,
    dependsOn: null,
    groupId: null,
    status: 'pending',
    contentHash: 'x',
    createdAt: 0,
    updatedAt: 0,
  } as WorkstreamPlanStepRow;
}

/**
 * Mirrors exactly how plan-executor.ts embeds the producer output into a
 * decision rationale (the rationale begins with the prefix + contains the
 * verbatim producer output incl. the marker block).
 */
function asDecisionRationale(producerOutput: string): string {
  return (
    `${PV_STRINGING_DECISION_PREFIX} step=STEP-1 role=coder ` +
    `deterministic=true no_spawn=true no_worktree=true — producer output ` +
    `(verbatim, N1):\n${producerOutput}`
  );
}

/** "Only roof drawer" remainder package around the electrical model (like wiring.test.ts). */
function packageAround(producerArtifact: GenericBuildArtifact): GenericBuildArtifact {
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
      inverters: sp.inverters,
      strings: sp.strings,
      simulation: sim,
      quote,
      approval,
    },
    decisions: [{ decisionId: 'stringing-validated' }, { kind: 'yield-simulated' }],
  };
}

// ───────────────────────────────────────────────────────────────────────────
// (1) Marker extraction
// ───────────────────────────────────────────────────────────────────────────

describe('parsePvStringingArtifactBlock', () => {
  it('extracts the artifact from a decision rationale (real producer output)', () => {
    const out = runPvStringingStep(
      makeStep({ roofPlanes: [givenRoofPlane()], module: givenModule(), inverter: givenInverter() }),
    );
    const rationale = asDecisionRationale(out);
    const parsed = parsePvStringingArtifactBlock(rationale);
    expect(parsed).not.toBeNull();
    expect((parsed!.surfacePayload?.strings ?? []).length).toBeGreaterThan(0);
    expect((parsed!.surfacePayload?.inverters ?? []).length).toBeGreaterThan(0);
  });

  it('shares the marker format with the source of truth in plan-executor', () => {
    expect(PV_STRINGING_ARTIFACT_OPEN).toBe(PV_STRINGING_OUTPUT_MARKER);
  });

  it('fail-soft: no marker → null', () => {
    expect(parsePvStringingArtifactBlock('just text, no marker')).toBeNull();
  });

  it('fail-soft: non-string → null', () => {
    expect(parsePvStringingArtifactBlock(42)).toBeNull();
    expect(parsePvStringingArtifactBlock(null)).toBeNull();
  });

  it('fail-soft: broken JSON in the marker → null', () => {
    const broken = `x ${PV_STRINGING_ARTIFACT_OPEN}{ broken ::: }</pv-stringing-artifact> y`;
    expect(parsePvStringingArtifactBlock(broken)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (2) Additive merge
// ───────────────────────────────────────────────────────────────────────────

describe('mergeBuildArtifacts', () => {
  it('unions surface lists + decisions additively', () => {
    const a: GenericBuildArtifact = {
      surfacePayload: { strings: [{ id: 's1' }], inverters: [{ id: 'i1' }] },
      decisions: [{ decisionId: 'stringing-validated' }],
    };
    const b: GenericBuildArtifact = {
      surfacePayload: { modules: [{ id: 'm1' }], roofPlanes: [{ id: 'r1' }] },
      decisions: [{ kind: 'yield-simulated' }],
    };
    const merged = mergeBuildArtifacts([a, b]);
    expect(merged.surfacePayload?.strings).toHaveLength(1);
    expect(merged.surfacePayload?.modules).toHaveLength(1);
    expect(merged.surfacePayload?.roofPlanes).toHaveLength(1);
    expect(merged.decisions).toHaveLength(2);
  });

  it('fail-soft: null/undefined entries are skipped', () => {
    const merged = mergeBuildArtifacts([null, undefined, { surfacePayload: { strings: [{ id: 's' }] } }]);
    expect(merged.surfacePayload?.strings).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (3) Test case selection
// ───────────────────────────────────────────────────────────────────────────

describe('pickTestCaseForArtifact', () => {
  it('picks the most demanding fully-passed case (simple-roof)', () => {
    const out = runPvStringingStep(
      makeStep({ roofPlanes: [givenRoofPlane()], module: givenModule(), inverter: givenInverter() }),
    );
    const producerArtifact = parsePvStringingArtifactBlock(asDecisionRationale(out))!;
    const pv = mapArtifactToPvArtifact(packageAround(producerArtifact));
    const id = pickTestCaseForArtifact(pv);
    // simple-roof is fully passed (producer + remainder package).
    expect(evaluateArtifact(pv, getTestCase(id)).passed).toBe(true);
    expect(id).toBe('simple-roof');
  });

  it('falls back to the narrowest PV yardstick when no case passes (empty electrical model)', () => {
    // Only a roof surface, no electrical model, no fitting PASS.
    const pv = mapArtifactToPvArtifact({
      surfacePayload: { building: { id: 'b', leadId: 'l', roofType: 'gable' } },
    });
    const id = pickTestCaseForArtifact(pv);
    expect(id).toBe(DEFAULT_PV_TEST_CASE_ID);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (4) The main hop: decision rationales → domain-eval context
// ───────────────────────────────────────────────────────────────────────────

describe('buildPvDomainEvalFromDecisions (THE LIVE HOP)', () => {
  it('builds a G5-PASS context from a pv-stringing decision + remainder package', () => {
    const out = runPvStringingStep(
      makeStep({ roofPlanes: [givenRoofPlane()], module: givenModule(), inverter: givenInverter() }),
    );
    const rationale = asDecisionRationale(out);
    // The remainder package (roof/lead/sim/quote/approval + decisions) is
    // produced by other run steps; we pass it in as an extraArtifact (the way
    // the in-memory stepOutputs would).
    const producerArtifact = parsePvStringingArtifactBlock(rationale)!;
    const domainEval = buildPvDomainEvalFromDecisions(
      [rationale],
      [packageAround(producerArtifact)],
    );
    expect(domainEval).not.toBeNull();
    expect(domainEval!.testCaseId).toBe('simple-roof');
    const verdict = evaluateArtifact(domainEval!.pvArtifact, getTestCase(domainEval!.testCaseId));
    expect(verdict.passed).toBe(true);
  });

  it('pure pv-stringing output (no remainder package): carries the electrical model, G5 yardstick armed', () => {
    const out = runPvStringingStep(
      makeStep({ roofPlanes: [givenRoofPlane()], module: givenModule(), inverter: givenInverter() }),
    );
    const domainEval = buildPvDomainEvalFromDecisions([asDecisionRationale(out)]);
    expect(domainEval).not.toBeNull();
    // strings + inverter are present (the electrical core model).
    const pv = domainEval!.pvArtifact;
    const kinds = pv.objects.map((o) => o.kind);
    expect(kinds).toContain('string');
    expect(kinds).toContain('inverter');
  });

  it('NO pv-stringing output → null (spine sets no domainEval → G5 fallback)', () => {
    expect(buildPvDomainEvalFromDecisions(['portfolio-stage-completed: governance-gate-contract'])).toBeNull();
    expect(buildPvDomainEvalFromDecisions([])).toBeNull();
    expect(buildPvDomainEvalFromDecisions([null, undefined])).toBeNull();
  });

  it('fail-soft: empty electrical model (no configJson) → carries no objects/decisions → null', () => {
    // Without hardware the producer stays honestly empty.
    const out = runPvStringingStep(makeStep(null));
    const domainEval = buildPvDomainEvalFromDecisions([asDecisionRationale(out)]);
    // Pure empty producer output → no objects, no decisions → null.
    expect(domainEval).toBeNull();
  });
});
