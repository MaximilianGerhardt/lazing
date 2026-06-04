/**
 * Demo PV (photovoltaic) / PV stringing · WIRING test
 * ════════════════════════════════════════════════════════════════════════
 *
 * Proves the WIRING of the finished producer into the execution loop
 * (lib/workstreams/plan-executor.ts) — the missing integration point between
 * the deterministic producer (producer.ts, G5 BLOCK→PASS already verified in
 * producer.test.ts) and the step executor.
 *
 * What is proven here (in addition to producer.test.ts):
 *   (1) DETECTION: a step with `| flow:{...,"skill":"pv-stringing",...}` in the
 *       rationale (as persisted by lib/flow/execute.ts::annotateRationale) is
 *       detected by isPvStringingStep — AND a free decompose step without an
 *       annotation via the title pattern.
 *   (2) INPUT EXTRACTION: extractStringingInput reads RoofPlane/module/inverter
 *       from the configJson annotation; if missing → honestly empty (no guessing).
 *   (3) EXECUTION → ARTIFACT: runPvStringingStep calls produceStringingPlan,
 *       stores the PvArtifact serialized; parsePvStringingOutput reads it back.
 *   (4) G5 IN FLOW CONTEXT: the step output produced this way, fed through
 *       from-artifact.ts → evaluate.ts, makes only-roof-drawer +
 *       no-electrical-model NO longer trigger → G5 BLOCK→PASS (no only-roof-drawer).
 *
 * Run:
 *   pnpm vitest run lib/eval/demo-pv/__tests__/wiring.test.ts
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
import { evaluateArtifact, toG5GateResult } from '@/lib/eval/demo-pv/evaluate';
import {
  mapArtifactToPvArtifact,
  type GenericBuildArtifact,
} from '@/lib/eval/demo-pv/from-artifact';
import { getTestCase } from '@/lib/eval/demo-pv/test-cases';
import {
  extractStringingInput,
  isPvStringingStep,
  parsePvStringingOutput,
  runPvStringingStep,
  PV_STRINGING_OUTPUT_MARKER,
} from '@/lib/workstreams/plan-executor';
import type { WorkstreamPlanStepRow } from '@/db/schema/workstream_plan_steps';

// ───────────────────────────────────────────────────────────────────────────
// Given hardware (NOT invented by the producer) — identical to producer.test.ts.
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
// Step-row builder — mirrors how lib/flow/execute.ts::annotateRationale writes
// the pv-stringing annotation + configJson into the rationale.
// ───────────────────────────────────────────────────────────────────────────

function makeStep(opts: {
  title: string;
  rationale?: string;
  skill?: string | null;
  config?: Record<string, unknown> | null;
  subagentRole?: string | null;
}): WorkstreamPlanStepRow {
  // Append the annotation ONLY when a skill OR config is given (otherwise a free
  // decompose plan without a ` | flow:` suffix → title-fallback path).
  let rationale = opts.rationale ?? 'PV stringing layout for the given hardware.';
  if (opts.skill !== undefined || opts.config !== undefined) {
    const annotation = {
      flowStepId: 'FS-1',
      skill: opts.skill ?? null,
      toolKind: null,
      connectorId: null,
      configJson: opts.config != null ? JSON.stringify(opts.config) : null,
    };
    rationale = `${rationale} | flow:${JSON.stringify(annotation)}`;
  }
  return {
    id: 'STEP-1',
    workstreamId: 'WS-1',
    planId: 'PLAN-1',
    parentStepId: null,
    stepIndex: 0,
    title: opts.title,
    rationale,
    subagentRole: opts.subagentRole ?? 'coder',
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
 * Builds the "only roof drawer" remainder package around the producer output
 * (building+roof+lead+sim+quote+approval) so the simple-roof case is fully
 * satisfiable — the producer's decisive contribution is inverters[]+strings[].
 * (Identical shell as producer.test.ts::packageAroundProducer.)
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
// (1) Step detection
// ───────────────────────────────────────────────────────────────────────────

describe('isPvStringingStep — detection via flow annotation + title fallback', () => {
  it('detects the step via the `| flow:{skill:"pv-stringing"}` annotation (even with a neutral title)', () => {
    const step = makeStep({ title: 'Step 3', skill: 'pv-stringing' });
    expect(isPvStringingStep(step)).toBe(true);
  });

  it('detects a free decompose step without an annotation via the title pattern', () => {
    const step = makeStep({ title: 'PV layout & inverter stringing' });
    expect(isPvStringingStep(step)).toBe(true);
  });

  it('does NOT detect a generic step as pv-stringing', () => {
    const step = makeStep({ title: 'Design the hero section', skill: 'design' });
    expect(isPvStringingStep(step)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (2) Input extraction (honestly empty without configJson)
// ───────────────────────────────────────────────────────────────────────────

describe('extractStringingInput — hardware from configJson, otherwise honestly empty', () => {
  it('reads RoofPlane/module/inverter from the configJson annotation', () => {
    const step = makeStep({
      title: 'Stringing',
      skill: 'pv-stringing',
      config: {
        roofPlanes: [givenRoofPlane()],
        module: givenModule(),
        inverter: givenInverter(),
      },
    });
    const input = extractStringingInput(step);
    expect(input.roofPlanes).toHaveLength(1);
    expect(input.module?.id).toBe('mod-1');
    expect(input.inverter?.id).toBe('inv-1');
  });

  it('without configJson → empty inputs (no guessing, no default hardware)', () => {
    const step = makeStep({ title: 'Stringing', skill: 'pv-stringing' });
    const input = extractStringingInput(step);
    expect(input.roofPlanes).toEqual([]);
    expect(input.module).toBeUndefined();
    expect(input.inverter).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (3) + (4) Execution → artifact → G5 PASS in flow context
// ───────────────────────────────────────────────────────────────────────────

describe('runPvStringingStep → from-artifact → evaluate: G5 BLOCK→PASS (flow context)', () => {
  it('serializes a PvArtifact with strings[]/inverters[] in the step output', () => {
    const step = makeStep({
      title: 'PV stringing',
      skill: 'pv-stringing',
      config: {
        roofPlanes: [givenRoofPlane()],
        module: givenModule(),
        inverter: givenInverter(),
      },
    });
    const output = runPvStringingStep(step);
    expect(output).toContain(PV_STRINGING_OUTPUT_MARKER);
    expect(output).toContain('0 (PASS)'); // self-verification: 0 rule violations

    const parsed = parsePvStringingOutput(output) as GenericBuildArtifact | null;
    expect(parsed).not.toBeNull();
    expect((parsed!.surfacePayload?.strings ?? []).length).toBeGreaterThan(0);
    expect((parsed!.surfacePayload?.inverters ?? []).length).toBeGreaterThan(0);
  });

  it('without a producer step: only roof drawer → G5 BLOCK (only-roof-drawer + no-electrical-model)', () => {
    // Control case: only a roof surface, NO pv-stringing step ran.
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
    expect(toG5GateResult(verdict).passed).toBe(false);
    const tripped = verdict.trippedBlockers.map((b) => b.blocker);
    expect(tripped).toContain('only-roof-drawer');
    expect(tripped).toContain('no-electrical-model');
  });

  it('WITH a pv-stringing step (wired producer output): G5 PASS — no only-roof-drawer', () => {
    // 1. The pv-stringing step runs in the executor path (deterministic).
    const step = makeStep({
      title: 'PV stringing layout',
      skill: 'pv-stringing',
      config: {
        roofPlanes: [givenRoofPlane()],
        module: givenModule(),
        inverter: givenInverter(),
      },
    });
    const output = runPvStringingStep(step);

    // 2. Read the artifact back from the step output (as a downstream consumer
    //    / from-artifact adapter pulls it from the stepOutput).
    const producerArtifact = parsePvStringingOutput(output) as GenericBuildArtifact;
    expect(producerArtifact).not.toBeNull();
    expect((producerArtifact.surfacePayload?.strings ?? []).length).toBeGreaterThan(0);

    // 3. Insert the electrical model into the "only roof drawer" remainder
    //    package and evaluate via from-artifact.ts → evaluate.ts (G5).
    const pv = mapArtifactToPvArtifact(packageAroundProducer(producerArtifact));
    const verdict = evaluateArtifact(pv, getTestCase('simple-roof'));
    const tripped = verdict.trippedBlockers.map((b) => b.blocker);

    // The previously blocking detectors NO longer fire (no only-roof-drawer).
    expect(tripped).not.toContain('only-roof-drawer');
    expect(tripped).not.toContain('no-electrical-model');
    expect(tripped).not.toContain('stringing-rule-violated');

    // G5 BLOCK → PASS.
    const gate = toG5GateResult(verdict);
    expect(verdict.passed).toBe(true);
    expect(gate.passed).toBe(true);
    expect(gate.blockingItems).toEqual([]);
  });

  it('without hardware (no configJson): producer stays honestly empty → G5 stays BLOCK (no invented model)', () => {
    const step = makeStep({ title: 'PV stringing', skill: 'pv-stringing' });
    const output = runPvStringingStep(step);
    const producerArtifact = parsePvStringingOutput(output) as GenericBuildArtifact;
    // Empty electrical model (no guessing).
    expect((producerArtifact.surfacePayload?.strings ?? [])).toEqual([]);
    expect((producerArtifact.surfacePayload?.inverters ?? [])).toEqual([]);

    const pv = mapArtifactToPvArtifact(packageAroundProducer(producerArtifact));
    const verdict = evaluateArtifact(pv, getTestCase('simple-roof'));
    // Without an electrical model the case correctly fails (intended, not a bug).
    expect(verdict.passed).toBe(false);
    expect(verdict.trippedBlockers.map((b) => b.blocker)).toContain('no-electrical-model');
  });
});
