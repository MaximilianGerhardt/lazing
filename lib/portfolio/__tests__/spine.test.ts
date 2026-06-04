/**
 * Phase 2 W2.0 — Portfolio-Spine tests.
 *
 * Strategie:
 *   - Reine Spine-Logik (validateLaneContract, canMergeStage, runQualityGate,
 *     MERGE_SEQUENCE-Konsistenz) → keine DB nötig, pure unit tests.
 *   - Persistenz-Roundtrip (loadPortfolioRunState) → in-memory better-sqlite3
 *     mit den ECHTEN Migrationen (0001 + 0009 + 0040 + 0071), genauso wie
 *     `state-projector.test.ts` es macht.
 *
 * Run:
 *   pnpm vitest run lib/portfolio/__tests__/spine.test.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  LANE_CONTRACT_TEMPLATES,
  MERGE_SEQUENCE,
  QUALITY_GATES,
  canMergeStage,
  emptyPortfolioRunState,
  loadPortfolioRunState,
  nextMergeableStages,
  runQualityGate,
  validateLaneContract,
} from '@/lib/portfolio/spine';
import type {
  LaneContract,
  LaneId,
  MergeStageId,
  PortfolioRunState,
} from '@/lib/portfolio/types';
import { LANE_IDS } from '@/lib/portfolio/types';
import {
  mapArtifactToPvArtifact,
  type GenericBuildArtifact,
} from '@/lib/eval/demo-pv/from-artifact';
import {
  PV_STRINGING_DECISION_PREFIX,
  parsePvStringingArtifactBlock,
} from '@/lib/eval/demo-pv/from-decisions';
import { runPvStringingStep } from '@/lib/workstreams/plan-executor';
import type { WorkstreamPlanStepRow } from '@/db/schema/workstream_plan_steps';

// ───────────────────────────────────────────────────────────────────────────
// Helpers — minimaler, gültiger LaneContract pro Lane.
// ───────────────────────────────────────────────────────────────────────────

function fullContract(overrides?: Partial<LaneContract>): LaneContract {
  return {
    inputEvents: ['intake.envelope.created'],
    outputEvents: ['expertise.object.compiled'],
    dataSchema: ['workstream_evidence', 'workspace_beliefs'],
    permissionRequirements: ['workspace:read', 'workspace:write'],
    confidenceBehavior: 'llm-with-validation',
    humanReviewRequirements: 'optional',
    errorStates: ['intake-empty', 'intake-malformed'],
    auditRequirements: ['workstream_evidence row per intake'],
    uxSurfaces: ['open-questions', 'plan-step'],
    metrics: ['intake_envelope_count', 'intake_latency_ms'],
    testFixtures: ['tests/fixtures/intake/sample.json'],
    rolloutConstraints: ['dry-run until LIVE flip'],
    ...overrides,
  };
}

function stateWithAllValidContracts(): PortfolioRunState {
  const state = emptyPortfolioRunState({
    portfolioRunId: 'WS-PORTFOLIO-TEST',
    workspaceId: 'ws-test',
    startedAt: 1000,
  });
  for (const id of LANE_IDS) {
    state.laneStates[id].contract = fullContract();
  }
  return state;
}

// ───────────────────────────────────────────────────────────────────────────
// validateLaneContract
// ───────────────────────────────────────────────────────────────────────────

describe('validateLaneContract', () => {
  it('accepts a complete 12-field contract', () => {
    const r = validateLaneContract(fullContract());
    expect(r.valid).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('rejects null/undefined contract', () => {
    expect(validateLaneContract(null).valid).toBe(false);
    expect(validateLaneContract(undefined).valid).toBe(false);
  });

  it('rejects contract with empty errorStates (Integration-Plan §6: Failure Modes pflicht)', () => {
    const r = validateLaneContract(fullContract({ errorStates: [] }));
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.includes('errorStates'))).toBe(true);
    expect(r.issues.some((i) => i.includes('Failure Modes'))).toBe(true);
  });

  it('rejects contract with empty inputEvents', () => {
    const r = validateLaneContract(fullContract({ inputEvents: [] }));
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.includes('inputEvents'))).toBe(true);
  });

  it('rejects contract with empty outputEvents', () => {
    const r = validateLaneContract(fullContract({ outputEvents: [] }));
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.includes('outputEvents'))).toBe(true);
  });

  it('rejects contract with empty dataSchema', () => {
    const r = validateLaneContract(fullContract({ dataSchema: [] }));
    expect(r.valid).toBe(false);
  });

  it('rejects contract with empty permissionRequirements', () => {
    const r = validateLaneContract(
      fullContract({ permissionRequirements: [] }),
    );
    expect(r.valid).toBe(false);
  });

  it('rejects contract with empty auditRequirements', () => {
    const r = validateLaneContract(fullContract({ auditRequirements: [] }));
    expect(r.valid).toBe(false);
  });

  it('rejects contract with empty uxSurfaces', () => {
    const r = validateLaneContract(fullContract({ uxSurfaces: [] }));
    expect(r.valid).toBe(false);
  });

  it('rejects contract with empty metrics', () => {
    const r = validateLaneContract(fullContract({ metrics: [] }));
    expect(r.valid).toBe(false);
  });

  it('rejects contract with empty testFixtures', () => {
    const r = validateLaneContract(fullContract({ testFixtures: [] }));
    expect(r.valid).toBe(false);
  });

  it('rejects contract with empty rolloutConstraints', () => {
    const r = validateLaneContract(fullContract({ rolloutConstraints: [] }));
    expect(r.valid).toBe(false);
  });

  it('rejects contract with invalid confidenceBehavior', () => {
    const c = fullContract();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).confidenceBehavior = 'guessing';
    const r = validateLaneContract(c);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.includes('confidenceBehavior'))).toBe(true);
  });

  it('rejects contract with invalid humanReviewRequirements', () => {
    const c = fullContract();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).humanReviewRequirements = 'whenever';
    const r = validateLaneContract(c);
    expect(r.valid).toBe(false);
  });

  it('rejects list entries that are empty strings', () => {
    const r = validateLaneContract(fullContract({ inputEvents: [''] }));
    expect(r.valid).toBe(false);
  });

  it('rejects list entries that are not strings', () => {
    const r = validateLaneContract(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fullContract({ inputEvents: [123 as any] }),
    );
    expect(r.valid).toBe(false);
  });

  it('reports MULTIPLE issues simultaneously (not just first)', () => {
    const r = validateLaneContract(
      fullContract({
        errorStates: [],
        inputEvents: [],
        dataSchema: [],
      }),
    );
    expect(r.valid).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// MERGE_SEQUENCE consistency
// ───────────────────────────────────────────────────────────────────────────

describe('MERGE_SEQUENCE', () => {
  it('has exactly 11 stages (Master-Kontext §6)', () => {
    expect(MERGE_SEQUENCE.length).toBe(11);
  });

  it('orders run from 1 to 11 with no gaps', () => {
    const orders = MERGE_SEQUENCE.map((s) => s.order).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('canonical stage order matches Master-Kontext §6 verbatim', () => {
    const expected: MergeStageId[] = [
      'governance-gate-contract',
      'source-event-envelope',
      'expertise-object-model',
      'role-decision-dependency-model',
      'toolstack-replacement-model',
      'innovation-reframe-model',
      'mobile-surface-model',
      'flow-graph-workstream-dag',
      'critic-eval-gates',
      'build-graph',
      'reconciliation-belief-update',
    ];
    const got = MERGE_SEQUENCE
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => s.id);
    expect(got).toEqual(expected);
  });

  it('requires-edges form a DAG (no cycles)', () => {
    // Topological sort attempt — must process all 11 stages without finding
    // a cycle. We use Kahn's algorithm.
    const ids = MERGE_SEQUENCE.map((s) => s.id);
    const incoming = new Map<MergeStageId, Set<MergeStageId>>();
    for (const s of MERGE_SEQUENCE) {
      incoming.set(s.id, new Set(s.requires));
    }
    const ordered: MergeStageId[] = [];
    while (incoming.size > 0) {
      const ready = [...incoming.entries()].find(([, deps]) => deps.size === 0);
      if (!ready) {
        throw new Error(
          `cycle detected — remaining: ${[...incoming.keys()].join(',')}`,
        );
      }
      ordered.push(ready[0]);
      incoming.delete(ready[0]);
      for (const deps of incoming.values()) deps.delete(ready[0]);
    }
    expect(ordered.length).toBe(ids.length);
  });

  it('every required stage exists in the sequence', () => {
    const validIds = new Set(MERGE_SEQUENCE.map((s) => s.id));
    for (const s of MERGE_SEQUENCE) {
      for (const req of s.requires) {
        expect(validIds.has(req)).toBe(true);
      }
    }
  });

  it('requires never references self or a later stage (sequence-consistent)', () => {
    for (const s of MERGE_SEQUENCE) {
      for (const req of s.requires) {
        const reqStage = MERGE_SEQUENCE.find((x) => x.id === req);
        expect(reqStage).toBeDefined();
        expect(reqStage!.order).toBeLessThan(s.order);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// canMergeStage / nextMergeableStages
// ───────────────────────────────────────────────────────────────────────────

describe('canMergeStage', () => {
  it('Stage 1 (governance-gate-contract) is merge-ready with all valid contracts and no prior merges', () => {
    const state = stateWithAllValidContracts();
    const r = canMergeStage(state, 'governance-gate-contract');
    expect(r.ok).toBe(true);
    expect(r.blockingRequirements).toEqual([]);
    expect(r.blockingGates).toEqual([]);
  });

  it('Stage 5 (toolstack-replacement-model) blocks when Stage 4 is missing', () => {
    const state = stateWithAllValidContracts();
    // Mark stages 1, 2, 3 as merged — but NOT 4.
    state.completedMergeStages = [
      'governance-gate-contract',
      'source-event-envelope',
      'expertise-object-model',
    ];
    const r = canMergeStage(state, 'toolstack-replacement-model');
    expect(r.ok).toBe(false);
    expect(r.blockingRequirements).toContain('role-decision-dependency-model');
  });

  it('Stage 5 unblocks when Stage 4 is added to completedMergeStages', () => {
    const state = stateWithAllValidContracts();
    state.completedMergeStages = [
      'governance-gate-contract',
      'source-event-envelope',
      'expertise-object-model',
      'role-decision-dependency-model',
    ];
    const r = canMergeStage(state, 'toolstack-replacement-model');
    expect(r.ok).toBe(true);
  });

  it('Stage 1 cannot be merged twice', () => {
    const state = stateWithAllValidContracts();
    state.completedMergeStages = ['governance-gate-contract'];
    const r = canMergeStage(state, 'governance-gate-contract');
    expect(r.ok).toBe(false);
  });

  it('Stage 1 blocks if even one lane has missing contract (G1 fails)', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['governance'].contract = null;
    const r = canMergeStage(state, 'governance-gate-contract');
    expect(r.ok).toBe(false);
    expect(r.blockingGates).toContain('G1-concept-integrity');
  });

  it('nextMergeableStages returns Stage 1 first on empty state with valid contracts', () => {
    const state = stateWithAllValidContracts();
    const next = nextMergeableStages(state);
    // Stage 1 ist die einzige ohne requires → sollte mergeable sein.
    // Andere Stages haben requires=Stage(n-1), die noch nicht merged ist →
    // dürfen NICHT mergeable sein.
    expect(next).toContain('governance-gate-contract');
    expect(next).not.toContain('source-event-envelope');
    expect(next).not.toContain('reconciliation-belief-update');
  });

  it('returns unknown stage as ok=false', () => {
    const state = stateWithAllValidContracts();
    const r = canMergeStage(state, 'no-such-stage' as MergeStageId);
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// runQualityGate — pro Gate ein Test (verbatim aus Integration-Plan §7).
// ───────────────────────────────────────────────────────────────────────────

describe('runQualityGate', () => {
  it('exposes exactly 6 gates G1..G6', () => {
    expect(QUALITY_GATES.length).toBe(6);
    const ids = QUALITY_GATES.map((g) => g.id).sort();
    expect(ids).toEqual([
      'G1-concept-integrity',
      'G2-data-readiness',
      'G3-governance-readiness',
      'G4-workflow-readiness',
      'G5-domain-depth',
      'G6-build-readiness',
    ]);
  });

  it('every gate has a non-empty verbatim question string', () => {
    for (const g of QUALITY_GATES) {
      expect(typeof g.question).toBe('string');
      expect(g.question.length).toBeGreaterThan(10);
    }
  });

  it('G1 passes when all 7 lanes have valid contracts with errorStates', () => {
    const state = stateWithAllValidContracts();
    const r = runQualityGate(state, 'G1-concept-integrity');
    expect(r.passed).toBe(true);
  });

  it('G1 fails when one lane has no contract (Failure-Modes nicht benennbar)', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['innovation-mode'].contract = null;
    const r = runQualityGate(state, 'G1-concept-integrity');
    expect(r.passed).toBe(false);
    expect(r.blockingItems).toContain('innovation-mode');
  });

  it('G2 fails when a lane has empty dataSchema', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['expertise-compiler'].contract = fullContract({
      dataSchema: ['x'], // dummy, must pass validateLaneContract
    });
    // Override after-the-fact — wir wollen G2 isoliert testen.
    state.laneStates['expertise-compiler'].contract!.dataSchema = [];
    const r = runQualityGate(state, 'G2-data-readiness');
    expect(r.passed).toBe(false);
  });

  it('G3 fails when a lane has no permissionRequirements', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['governance'].contract!.permissionRequirements = [];
    const r = runQualityGate(state, 'G3-governance-readiness');
    expect(r.passed).toBe(false);
    expect(
      r.blockingItems.some((b) => b.startsWith('governance:no-permissions')),
    ).toBe(true);
  });

  it('G4 fails when a non-governance lane is missing inputEvents', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['mobile-ux'].contract!.inputEvents = [];
    const r = runQualityGate(state, 'G4-workflow-readiness');
    expect(r.passed).toBe(false);
  });

  it('G5 fails when an LLM lane has no human-review and only 1 metric (shallow domain)', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['innovation-mode'].contract = fullContract({
      confidenceBehavior: 'llm-with-validation',
      humanReviewRequirements: 'none',
      metrics: ['only-one'],
    });
    const r = runQualityGate(state, 'G5-domain-depth');
    expect(r.passed).toBe(false);
  });

  it('G5 passes when LLM lane has human-review even with 1 metric', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['innovation-mode'].contract = fullContract({
      confidenceBehavior: 'llm-with-human-review',
      humanReviewRequirements: 'required',
      metrics: ['decisions-made'],
    });
    const r = runQualityGate(state, 'G5-domain-depth');
    expect(r.passed).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // G5 anti-MVP bridge: real Demo PV domain eval (instead of a proxy).
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Ein vollständiges PV-Build-Output (Surface + Decisions), das nach dem
   * Adapter-Mapping den Simple-Roof-Case besteht.
   */
  function completePvBuildArtifact() {
    return {
      surfacePayload: {
        lead: {
          id: 'lead-1',
          source: 'web-form',
          addressLine: 'Musterweg 1',
          postalCode: '12345',
          isPropertyOwner: true,
          annualConsumptionKwhEstimate: 4500,
        },
        building: {
          id: 'bld-1',
          leadId: 'lead-1',
          roofType: 'gable',
          roofPlaneCount: 1,
          roofCovering: 'Tonziegel',
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
        modules: [{ id: 'mod-1', wattPeak: 440, vocStc: 38.5, vmpStc: 32 }],
        inverters: [
          {
            id: 'inv-1',
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
        simulation: { id: 'sim-1', buildingId: 'bld-1', annualYieldKwh: 5200 },
        quote: {
          id: 'q-1',
          leadId: 'lead-1',
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
    };
  }

  /** (a) Vollständiges PV-Paket → G5 PASS über die echte Eval. */
  it('G5 passes via real Demo PV eval for a complete PV package', () => {
    const state = stateWithAllValidContracts();
    state.domainEval = {
      pvArtifact: mapArtifactToPvArtifact(completePvBuildArtifact()),
      testCaseId: 'simple-roof',
    };
    const r = runQualityGate(state, 'G5-domain-depth');
    expect(r.passed).toBe(true);
    expect(r.reason).toContain('Domain-Eval');
    expect(r.blockingItems).toEqual([]);
  });

  /** (b) „Nur Dachzeichner"-Artefakt → G5 FAIL mit konkreten blockingItems. */
  it('G5 FAILS via real eval for a roof-drawer-only artefact (Anti-MVP)', () => {
    const state = stateWithAllValidContracts();
    state.domainEval = {
      pvArtifact: mapArtifactToPvArtifact({
        surfacePayload: {
          building: { id: 'bld-x', leadId: 'lead-x', roofType: 'gable' },
          roofPlanes: [{ id: 'rp-x', buildingId: 'bld-x', azimuthDeg: 180 }],
        },
      }),
      testCaseId: 'simple-roof',
    };
    const r = runQualityGate(state, 'G5-domain-depth');
    expect(r.passed).toBe(false);
    // Konkrete blockingItems: fehlende Objekte UND ausgelöste Blocker.
    expect(r.blockingItems).toContain('missing-object:string');
    expect(r.blockingItems).toContain('missing-object:inverter');
    expect(r.blockingItems).toContain('blocker:only-roof-drawer');
    expect(r.blockingItems).toContain('blocker:no-electrical-model');
  });

  /** (b') Roof-drawer-only blockiert auch Stage 9 (critic-eval-gates erbt G5? Nein —
   *  G5 hängt an Stage 3/4/5. Wir prüfen, dass die G5-führende Stage blockiert. */
  it('roof-drawer-only G5-fail blocks the expertise-object-model stage (G5 carrier)', () => {
    const state = stateWithAllValidContracts();
    state.completedMergeStages = [
      'governance-gate-contract',
      'source-event-envelope',
    ];
    state.domainEval = {
      pvArtifact: mapArtifactToPvArtifact({
        surfacePayload: {
          building: { id: 'bld-x', leadId: 'lead-x', roofType: 'gable' },
          roofPlanes: [{ id: 'rp-x', buildingId: 'bld-x', azimuthDeg: 180 }],
        },
      }),
      testCaseId: 'simple-roof',
    };
    const r = canMergeStage(state, 'expertise-object-model');
    expect(r.ok).toBe(false);
    expect(r.blockingGates).toContain('G5-domain-depth');
  });

  /** (c) Nicht-PV-Lane (kein domainEval) → G5 nutzt Fallback, kein Crash. */
  it('G5 falls back to the heuristic for a non-PV lane (no domainEval, no crash)', () => {
    const state = stateWithAllValidContracts();
    expect(state.domainEval ?? null).toBeNull();
    const r = runQualityGate(state, 'G5-domain-depth');
    // Alle Contracts valide + (Default fullContract hat 2 Metriken) → Fallback ok.
    expect(r.passed).toBe(true);
    expect(r.reason).not.toContain('Domain-Eval');
  });

  /** (c') Defekter domainEval (kein gültiges PvArtifact) → Fallback statt Crash. */
  it('G5 ignores a malformed domainEval and uses the fallback', () => {
    const state = stateWithAllValidContracts();
    state.domainEval = {
      pvArtifact: { objects: 'not-an-array' },
      testCaseId: 'simple-roof',
    } as unknown as PortfolioRunState['domainEval'];
    const r = runQualityGate(state, 'G5-domain-depth');
    expect(r.passed).toBe(true);
    expect(r.reason).not.toContain('Domain-Eval');
  });

  /** (c'') Unbekannte testCaseId → Fallback statt Crash. */
  it('G5 ignores an unknown testCaseId and uses the fallback', () => {
    const state = stateWithAllValidContracts();
    state.domainEval = {
      pvArtifact: mapArtifactToPvArtifact(completePvBuildArtifact()),
      testCaseId: 'does-not-exist',
    };
    const r = runQualityGate(state, 'G5-domain-depth');
    expect(r.passed).toBe(true);
    expect(r.reason).not.toContain('Domain-Eval');
  });

  it('G6 fails when a lane has no testFixtures', () => {
    const state = stateWithAllValidContracts();
    state.laneStates['toolstack-replacement'].contract!.testFixtures = [];
    const r = runQualityGate(state, 'G6-build-readiness');
    expect(r.passed).toBe(false);
  });

  it('unknown gate returns passed=false with descriptive reason', () => {
    const state = stateWithAllValidContracts();
    const r = runQualityGate(state, 'G99-bogus' as 'G1-concept-integrity');
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('unknown gate');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// LANE_CONTRACT_TEMPLATES
// ───────────────────────────────────────────────────────────────────────────

describe('LANE_CONTRACT_TEMPLATES', () => {
  it('exposes a template patch for every LaneId', () => {
    for (const id of LANE_IDS) {
      expect(LANE_CONTRACT_TEMPLATES[id]).toBeDefined();
    }
  });

  it('governance template is deterministic and human-review required', () => {
    const t = LANE_CONTRACT_TEMPLATES['governance'];
    expect(t.confidenceBehavior).toBe('deterministic');
    expect(t.humanReviewRequirements).toBe('required');
  });

  it('innovation-mode template requires human-review (reframe needs founder)', () => {
    const t = LANE_CONTRACT_TEMPLATES['innovation-mode'];
    expect(t.humanReviewRequirements).toBe('required');
  });

  it('templates do NOT pre-fill list fields (validation must fail until lane fills them in)', () => {
    // The templates are intentionally minimal — they fill enum/scalar fields
    // but the implementing lane MUST add concrete event lists / metrics / etc.
    // We assert that lists are absent (undefined) in the template, except
    // auditRequirements which we DO pre-fill as a hint.
    for (const id of LANE_IDS) {
      const t = LANE_CONTRACT_TEMPLATES[id];
      expect(t.inputEvents).toBeUndefined();
      expect(t.outputEvents).toBeUndefined();
      expect(t.errorStates).toBeUndefined();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// emptyPortfolioRunState
// ───────────────────────────────────────────────────────────────────────────

describe('emptyPortfolioRunState', () => {
  it('initialises all 7 lanes as not-started with null contract', () => {
    const s = emptyPortfolioRunState({
      portfolioRunId: 'WS-PORTFOLIO-X',
      workspaceId: 'ws-x',
      startedAt: 42,
    });
    expect(Object.keys(s.laneStates).sort()).toEqual([...LANE_IDS].sort());
    for (const id of LANE_IDS) {
      expect(s.laneStates[id].status).toBe('not-started');
      expect(s.laneStates[id].contract).toBeNull();
      expect(s.laneStates[id].workstreamId).toBeNull();
      expect(s.laneStates[id].artifactRefs).toEqual([]);
    }
    expect(s.completedMergeStages).toEqual([]);
    expect(s.blockedAt).toBeNull();
    expect(s.blockedReason).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// loadPortfolioRunState — DB roundtrip with REAL migrations.
// ───────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');

function loadSql(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

function freshDb(): import('better-sqlite3').Database {
  const raw = new Database(':memory:');
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = OFF');
  raw.exec(loadSql('0001_initial.sql'));
  raw.exec(loadSql('0009_workstreams.sql'));
  // 0040 adds parent_workstream_id, role, tokens_in/out, cost_cents_aggregated.
  // Re-running on a fresh schema → ALTERs succeed.
  raw.exec(loadSql('0040_sub_workstreams.sql'));
  // 0048 adds mode column on workstreams (Tier-Lock phase). Loaded
  // defensively — wenn fehlend, fallen wir auf manuelle Spalte zurück.
  try {
    raw.exec(loadSql('0048_workstream_mode.sql'));
  } catch {
    // manuelle Fallback-Spalte: einige Migrations-Stände hatten `mode` woanders.
    try {
      raw.exec(`ALTER TABLE workstreams ADD COLUMN mode TEXT`);
    } catch {
      /* schon vorhanden — ok */
    }
  }
  // 0071 workstream_decisions table.
  raw.exec(loadSql('0071_workstream_decisions.sql'));
  return raw;
}

function insertWorkstream(
  raw: import('better-sqlite3').Database,
  args: {
    id: string;
    workspaceId: string;
    name: string;
    status?: string;
    parent?: string | null;
    role?: string | null;
    mode?: string | null;
    updatedAt?: number;
    createdAt?: number;
  },
): void {
  const now = args.updatedAt ?? Date.now();
  const created = args.createdAt ?? now;
  raw
    .prepare(
      `INSERT INTO workstreams (id, workspace_id, name, status,
                                parent_workstream_id, role, mode,
                                created_at, updated_at,
                                tokens_in, tokens_out, cost_cents_aggregated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
    )
    .run(
      args.id,
      args.workspaceId,
      args.name,
      args.status ?? 'active',
      args.parent ?? null,
      args.role ?? null,
      args.mode ?? null,
      created,
      now,
    );
}

function insertDecision(
  raw: import('better-sqlite3').Database,
  args: {
    id: string;
    workstreamId: string;
    decisionKind: string;
    rationale: string;
    evidenceRefs?: string[];
    contentHash?: string;
    createdAt?: number;
  },
): void {
  raw
    .prepare(
      `INSERT INTO workstream_decisions
        (id, workstream_id, decision_kind, rationale, evidence_refs,
         content_hash, created_at, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'agent')`,
    )
    .run(
      args.id,
      args.workstreamId,
      args.decisionKind,
      args.rationale,
      JSON.stringify(args.evidenceRefs ?? ['ev-1']),
      args.contentHash ??
        '0000000000000000000000000000000000000000000000000000000000000001',
      args.createdAt ?? Math.floor(Date.now() / 1000),
    );
}

describe('loadPortfolioRunState (DB roundtrip)', () => {
  it('returns null when no portfolio parent-workstream exists', () => {
    const db = freshDb();
    const r = loadPortfolioRunState(db, 'ws-empty');
    expect(r).toBeNull();
  });

  it('returns a state with all 7 lanes when only the parent exists', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-1',
      workspaceId: 'ws-1',
      name: 'Portfolio: build CRM',
      mode: 'portfolio',
      createdAt: 1000,
      updatedAt: 2000,
    });
    const r = loadPortfolioRunState(db, 'ws-1');
    expect(r).not.toBeNull();
    expect(r!.portfolioRunId).toBe('WS-PORT-1');
    expect(r!.startedAt).toBe(1000);
    expect(Object.keys(r!.laneStates).sort()).toEqual([...LANE_IDS].sort());
    // All lanes still not-started (no child workstreams).
    for (const id of LANE_IDS) {
      expect(r!.laneStates[id].status).toBe('not-started');
    }
    expect(r!.completedMergeStages).toEqual([]);
  });

  it('picks up child workstreams as Lane states', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-2',
      workspaceId: 'ws-2',
      name: 'Portfolio',
      mode: 'portfolio',
      createdAt: 1,
      updatedAt: 1,
    });
    insertWorkstream(db, {
      id: 'WS-LANE-GOV',
      workspaceId: 'ws-2',
      name: 'Lane: governance',
      parent: 'WS-PORT-2',
      role: 'lane:governance',
      status: 'active',
    });
    insertWorkstream(db, {
      id: 'WS-LANE-INTAKE',
      workspaceId: 'ws-2',
      name: 'Lane: communication-intake',
      parent: 'WS-PORT-2',
      role: 'lane:communication-intake',
      status: 'done',
    });
    const r = loadPortfolioRunState(db, 'ws-2');
    expect(r).not.toBeNull();
    expect(r!.laneStates['governance'].workstreamId).toBe('WS-LANE-GOV');
    expect(r!.laneStates['governance'].status).toBe('running');
    expect(r!.laneStates['communication-intake'].workstreamId).toBe(
      'WS-LANE-INTAKE',
    );
    expect(r!.laneStates['communication-intake'].status).toBe('merged');
    // unrelated lanes still not-started.
    expect(r!.laneStates['mobile-ux'].workstreamId).toBeNull();
  });

  it('reads stage completions from workstream_decisions(route, "portfolio-stage-completed: …")', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-3',
      workspaceId: 'ws-3',
      name: 'Portfolio',
      mode: 'portfolio',
    });
    insertDecision(db, {
      id: 'DEC-1',
      workstreamId: 'WS-PORT-3',
      decisionKind: 'route',
      rationale:
        'portfolio-stage-completed: governance-gate-contract',
      contentHash:
        '1111111111111111111111111111111111111111111111111111111111111111',
    });
    insertDecision(db, {
      id: 'DEC-2',
      workstreamId: 'WS-PORT-3',
      decisionKind: 'route',
      rationale: 'portfolio-stage-completed: source-event-envelope',
      contentHash:
        '2222222222222222222222222222222222222222222222222222222222222222',
    });
    insertDecision(db, {
      id: 'DEC-3',
      workstreamId: 'WS-PORT-3',
      decisionKind: 'route',
      rationale: 'something-else: this is not a stage marker',
      contentHash:
        '3333333333333333333333333333333333333333333333333333333333333333',
    });
    const r = loadPortfolioRunState(db, 'ws-3');
    expect(r).not.toBeNull();
    expect(r!.completedMergeStages).toEqual([
      'governance-gate-contract',
      'source-event-envelope',
    ]);
  });

  it('computes blockedAt = first stage that cannot merge (and a verbatim reason)', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-4',
      workspaceId: 'ws-4',
      name: 'Portfolio',
      mode: 'portfolio',
    });
    const r = loadPortfolioRunState(db, 'ws-4');
    expect(r).not.toBeNull();
    // Mit leeren Verträgen sollte schon Stage 1 (governance-gate-contract)
    // blockieren — G1 schlägt fehl (alle Lanes ohne Vertrag).
    expect(r!.blockedAt).toBe('governance-gate-contract');
    expect(r!.blockedReason).toContain('gates:');
    expect(r!.blockedReason).toContain('G1-concept-integrity');
  });

  it('fail-soft on invalid workspaceId', () => {
    const db = freshDb();
    expect(loadPortfolioRunState(db, '')).toBeNull();
    // @ts-expect-error testing runtime safety against non-string input
    expect(loadPortfolioRunState(db, null)).toBeNull();
  });

  it('returns the JÜNGSTEN portfolio parent if multiple exist', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-OLD',
      workspaceId: 'ws-many',
      name: 'old',
      mode: 'portfolio',
      createdAt: 100,
      updatedAt: 100,
    });
    insertWorkstream(db, {
      id: 'WS-NEW',
      workspaceId: 'ws-many',
      name: 'new',
      mode: 'portfolio',
      createdAt: 200,
      updatedAt: 200,
    });
    const r = loadPortfolioRunState(db, 'ws-many');
    expect(r?.portfolioRunId).toBe('WS-NEW');
  });

  it('ignores workstreams from other workspaces (scope isolation)', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-OTHER',
      workspaceId: 'ws-other',
      name: 'other',
      mode: 'portfolio',
    });
    const r = loadPortfolioRunState(db, 'ws-mine');
    expect(r).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E2E: G5 LIVE im Spine/Portfolio-Pfad (DER finale Hop)
// ════════════════════════════════════════════════════════════════════════════
//
// Beweist, dass die Verdrahtung pv-stringing-stepOutput → state.domainEval.
// pvArtifact in `loadPortfolioRunState` GREIFT — also G5 im echten Flow scharf
// bewertet, nicht nur im Unit-Test:
//
//   pv-stringing-Producer (runPvStringingStep, deterministisch)
//     → persistiert als workstream_decisions(route, actor='policy',
//       rationale beginnt mit `pv_stringing_producer=true`, enthält Marker-Block)
//     → loadPortfolioRunState liest die Decision, baut state.domainEval
//     → runQualityGate(state, 'G5-domain-depth') = LIVE Domain-Eval-Verdikt.
//
// Plus Kontroll-Fälle: ohne pv-stringing-Decision → kein domainEval → Fallback;
// roof-drawer-only Producer-Output → domainEval gesetzt, aber G5 BLOCK.
// ───────────────────────────────────────────────────────────────────────────

/** Producer-Step mit der gegebenen Hardware (configJson-Annotation, wie der Flow). */
function pvStringingStep(config: Record<string, unknown> | null): WorkstreamPlanStepRow {
  const annotation = {
    flowStepId: 'FS-PV',
    skill: 'pv-stringing',
    toolKind: null,
    connectorId: null,
    configJson: config != null ? JSON.stringify(config) : null,
  };
  return {
    id: 'STEP-PV',
    workstreamId: 'WS-PV',
    planId: 'PLAN-PV',
    parentStepId: null,
    stepIndex: 0,
    title: 'PV-Stringing-Auslegung',
    rationale: `PV-Stringing | flow:${JSON.stringify(annotation)}`,
    subagentRole: 'coder',
    targetFilesJson: null,
    expectedArtifactsJson: null,
    depth: 0,
    coordKey: 'ws:WS-PV',
    allowedTools: null,
    dependsOn: null,
    groupId: null,
    status: 'pending',
    contentHash: 'x',
    createdAt: 0,
    updatedAt: 0,
  } as WorkstreamPlanStepRow;
}

const PV_HARDWARE = {
  roofPlanes: [
    {
      kind: 'roof-plane',
      id: 'rp-1',
      buildingId: 'bld-1',
      azimuthDeg: 180,
      tiltDeg: 35,
      areaM2: 40,
      usableAreaM2: 34,
    },
  ],
  module: {
    kind: 'module',
    id: 'mod-1',
    manufacturer: 'Acme',
    model: 'AC-440',
    wattPeak: 440,
    vocStc: 38.5,
    vmpStc: 32.0,
    tempCoeffVocPctPerC: -0.27,
  },
  inverter: {
    kind: 'inverter',
    id: 'inv-1',
    manufacturer: 'Acme',
    model: 'AC-5K',
    acNominalPowerW: 5000,
    maxDcPowerW: 7500,
    maxDcVoltageV: 600,
    mpptTrackers: 2,
    mpptVoltageWindowV: { min: 120, max: 500 },
  },
};

/**
 * Restpaket (Dach/Lead/Sim/Quote/Approval + stringing-validated/yield-simulated),
 * das andere Run-Steps liefern. Wird hier als ZWEITE pv-stringing-Decision
 * persistiert (verpackt im Marker-Block), damit loadPortfolioRunState es additiv
 * zum elektrischen Modell des Producers vereinigt — so erfüllt das gemergte
 * Artefakt `simple-roof` vollständig und G5 läuft LIVE auf PASS.
 */
function restPackageArtifact(producer: GenericBuildArtifact): GenericBuildArtifact {
  const sp = producer.surfacePayload ?? {};
  return {
    surfacePayload: {
      lead: {
        id: 'lead-1',
        source: 'web-form',
        addressLine: 'Musterweg 1',
        postalCode: '12345',
        isPropertyOwner: true,
        annualConsumptionKwhEstimate: 4500,
      },
      building: {
        kind: 'building',
        id: 'bld-1',
        leadId: 'lead-1',
        roofType: 'gable',
        roofPlaneCount: 1,
        roofCovering: 'Tonziegel',
        eaveHeightM: 6,
        structuralCheckDone: true,
      },
      roofPlanes: PV_HARDWARE.roofPlanes,
      modules: [PV_HARDWARE.module],
      inverters: sp.inverters,
      strings: sp.strings,
      simulation: {
        kind: 'simulation-run',
        id: 'sim-1',
        buildingId: 'bld-1',
        inputStringIds: ['str-1'],
        annualYieldKwh: 5200,
        selfConsumptionRatio: 0.35,
        autarkyRatio: 0.55,
        specificYieldKwhPerKwp: 985,
      },
      quote: {
        kind: 'quote',
        id: 'q-1',
        leadId: 'lead-1',
        netTotalEur: 14500,
        lineItemCount: 8,
        paybackYears: 11,
        requiresApprovalGrade: 'proposal',
      },
      approval: {
        kind: 'approval',
        id: 'ap-1',
        quoteId: 'q-1',
        grade: 'proposal',
        expertReviewed: true,
        reviewerRole: 'pv-planner',
      },
    },
    decisions: [{ decisionId: 'stringing-validated' }, { kind: 'yield-simulated' }],
  };
}

/** Verpackt ein GenericBuildArtifact in einen pv-stringing-Decision-Rationale-Text. */
function asPvDecisionRationale(artifact: GenericBuildArtifact, tag: string): string {
  return (
    `${PV_STRINGING_DECISION_PREFIX} step=${tag} role=coder ` +
    `deterministic=true no_spawn=true no_worktree=true — Producer-Output (verbatim, N1):\n` +
    `[head]\n<pv-stringing-artifact>${JSON.stringify(artifact)}</pv-stringing-artifact>`
  );
}

describe('E2E: loadPortfolioRunState wires pv-stringing → state.domainEval (G5 LIVE)', () => {
  let hashSeq = 0;
  function uniqueHash(): string {
    hashSeq += 1;
    return String(hashSeq).padStart(64, '0');
  }

  it('populates state.domainEval from a persisted pv-stringing decision → G5 LIVE PASS', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-PV',
      workspaceId: 'ws-pv',
      name: 'Portfolio: Demo PV',
      mode: 'portfolio',
      createdAt: 10,
      updatedAt: 10,
    });
    // Der pv-stringing-Step schreibt seine Decision in den Workstream des
    // laufenden Steps. Im flachen Run ist das der parent selbst.
    const producerOutput = runPvStringingStep(pvStringingStep(PV_HARDWARE));
    const producerArtifact = parsePvStringingArtifactBlock(producerOutput)!;
    // (1) die echte Producer-Decision (elektrisches Modell, verbatim Output).
    insertDecision(db, {
      id: 'DEC-PV-1',
      workstreamId: 'WS-PORT-PV',
      decisionKind: 'route',
      rationale:
        `${PV_STRINGING_DECISION_PREFIX} step=STEP-PV role=coder deterministic=true ` +
        `no_spawn=true no_worktree=true — Producer-Output (verbatim, N1):\n${producerOutput}`,
      contentHash: uniqueHash(),
    });
    // (2) das Restpaket (anderer Run-Step) als zweite pv-Decision.
    insertDecision(db, {
      id: 'DEC-PV-2',
      workstreamId: 'WS-PORT-PV',
      decisionKind: 'route',
      rationale: asPvDecisionRationale(restPackageArtifact(producerArtifact), 'STEP-REST'),
      contentHash: uniqueHash(),
    });

    const state = loadPortfolioRunState(db, 'ws-pv');
    expect(state).not.toBeNull();

    // DER HOP: domainEval ist befüllt.
    expect(state!.domainEval).not.toBeNull();
    const pv = state!.domainEval!.pvArtifact as { objects: Array<{ kind: string }> };
    const kinds = pv.objects.map((o) => o.kind);
    expect(kinds).toContain('string');
    expect(kinds).toContain('inverter');
    expect(state!.domainEval!.testCaseId).toBe('simple-roof');

    // G5 LIVE: the verdict comes from the REAL Demo PV eval (the reason carries
    // the "domain eval" prefix — the fallback would NEVER write that).
    const g5 = runQualityGate(state!, 'G5-domain-depth');
    expect(g5.passed).toBe(true);
    expect(g5.reason).toContain('Domain-Eval');
    expect(g5.blockingItems).toEqual([]);
  });

  it('CONTROL: no pv-stringing decision → no domainEval → G5 uses the contract fallback', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-NOPV',
      workspaceId: 'ws-nopv',
      name: 'Portfolio: kein PV',
      mode: 'portfolio',
      createdAt: 20,
      updatedAt: 20,
    });
    // Eine unverwandte route-Decision (Stage-Completion) — KEIN pv-stringing.
    insertDecision(db, {
      id: 'DEC-NOPV-1',
      workstreamId: 'WS-PORT-NOPV',
      decisionKind: 'route',
      rationale: 'portfolio-stage-completed: governance-gate-contract',
      contentHash: uniqueHash(),
    });

    const state = loadPortfolioRunState(db, 'ws-nopv');
    expect(state).not.toBeNull();
    // KEIN domainEval → G5 fällt auf die Lane-Contract-Heuristik zurück.
    expect(state!.domainEval ?? null).toBeNull();
    const g5 = runQualityGate(state!, 'G5-domain-depth');
    // Reason trägt NICHT den Domain-Eval-Präfix (Fallback-Pfad).
    expect(g5.reason).not.toContain('Domain-Eval');
  });

  it('CONTROL: roof-drawer-only producer output → domainEval set, but G5 BLOCK (Anti-MVP)', () => {
    const db = freshDb();
    insertWorkstream(db, {
      id: 'WS-PORT-ROOF',
      workspaceId: 'ws-roof',
      name: 'Portfolio: nur Dach',
      mode: 'portfolio',
      createdAt: 30,
      updatedAt: 30,
    });
    // Ein „nur Dachzeichner"-Artefakt: Building + RoofPlane, KEIN elektrisches
    // Modell — verpackt im pv-stringing-Marker (so wie ein degenerierter Run).
    const roofOnly: GenericBuildArtifact = {
      surfacePayload: {
        building: {
          kind: 'building',
          id: 'bld-x',
          leadId: 'lead-x',
          roofType: 'gable',
          roofPlaneCount: 1,
          roofCovering: 'Tonziegel',
          eaveHeightM: 6,
          structuralCheckDone: true,
        },
        roofPlanes: [
          { kind: 'roof-plane', id: 'rp-x', buildingId: 'bld-x', azimuthDeg: 180, tiltDeg: 30 },
        ],
      },
    };
    insertDecision(db, {
      id: 'DEC-ROOF-1',
      workstreamId: 'WS-PORT-ROOF',
      decisionKind: 'route',
      rationale: asPvDecisionRationale(roofOnly, 'STEP-ROOF'),
      contentHash: uniqueHash(),
    });

    const state = loadPortfolioRunState(db, 'ws-roof');
    expect(state).not.toBeNull();
    // domainEval ist gesetzt (Substanz da: Building+Roof), aber G5 bewertet scharf.
    expect(state!.domainEval).not.toBeNull();
    const g5 = runQualityGate(state!, 'G5-domain-depth');
    expect(g5.passed).toBe(false);
    expect(g5.reason).toContain('Domain-Eval');
    // Anti-MVP greift scharf: das elektrische Kernmodell fehlt. Der Picker wählt
    // für ein Artefakt ohne erfüllbaren Case den engsten PV-Maßstab
    // (stringing-constraint); dessen no-electrical-model-Blocker feuert.
    expect(g5.blockingItems).toContain('blocker:no-electrical-model');
    expect(g5.blockingItems).toContain('missing-object:string');
  });
});
