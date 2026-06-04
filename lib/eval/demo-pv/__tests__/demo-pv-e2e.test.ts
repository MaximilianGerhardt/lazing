/**
 * Demo PV (photovoltaic) eval · DEMO PV E2E (a demonstrable result)
 * ════════════════════════════════════════════════════════════════════════
 *
 * Proves the end-to-end chain for a "build an EXAMPLE PV project":
 *
 *   1. extractStringingInput detects the demo PV intent (title) and pulls — because
 *      NO owner hardware is present — the explicitly declared demo hardware set.
 *   2. runPvStringingStep → produceStringingPlan returns a COMPLETE electrical
 *      model: strings[] + inverters[] + modules[] + the decision
 *      `stringing-validated`. The demo assumptions are visible in the output.
 *   3. The serialized `<pv-stringing-artifact>` block, fed through the REAL spine
 *      hop (buildPvDomainEvalFromDecisions, as loadPortfolioRunState calls it),
 *      picks `stringing-constraint` and PASSES G5 LIVE.
 *   4. CONTROL: a REAL PV intent (without a demo keyword) without hardware stays
 *      honestly empty → G5 BLOCKs (no-electrical-model) — no fabricated PASS.
 *
 * Run:
 *   pnpm vitest run lib/eval/demo-pv/__tests__/demo-pv-e2e.test.ts
 */

import { describe, expect, it } from 'vitest';

import {
  buildPvDomainEvalFromDecisions,
  PV_STRINGING_DECISION_PREFIX,
} from '@/lib/eval/demo-pv/from-decisions';
import { evaluateArtifact, toG5GateResult } from '@/lib/eval/demo-pv/evaluate';
import { getTestCase } from '@/lib/eval/demo-pv/test-cases';
import {
  DEMO_MODULE,
  DEMO_INVERTER,
  isDemoPvIntent,
} from '@/lib/eval/demo-pv/demo-hardware';
import {
  extractStringingInput,
  isPvStringingStep,
  runPvStringingStep,
  PV_STRINGING_OUTPUT_MARKER,
} from '@/lib/workstreams/plan-executor';
import type { WorkstreamPlanStepRow } from '@/db/schema/workstream_plan_steps';

// ───────────────────────────────────────────────────────────────────────────
// Step-row builder — mirrors lib/flow/execute.ts::annotateRationale.
// ───────────────────────────────────────────────────────────────────────────

function makeStep(opts: {
  title: string;
  skill?: string | null;
  config?: Record<string, unknown> | null;
}): WorkstreamPlanStepRow {
  let rationale = 'PV stringing layout.';
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

/** How the plan-executor writes the producer decision into workstream_decisions.rationale. */
function asDecisionRationale(producerOutput: string): string {
  return `${PV_STRINGING_DECISION_PREFIX} step=STEP-1 deterministic=true — producer output:\n${producerOutput}`;
}

// ───────────────────────────────────────────────────────────────────────────
// Demo intent detection
// ───────────────────────────────────────────────────────────────────────────

describe('isDemoPvIntent — requires a demo keyword AND a PV context', () => {
  it('detects an explicit example PV intent', () => {
    expect(isDemoPvIntent('Build an example PV project')).toBe(true);
    expect(isDemoPvIntent('Demo: solar layout')).toBe(true);
    expect(isDemoPvIntent('Sample stringing for an inverter')).toBe(true);
  });

  it('does NOT trigger on demo without PV context or PV without a demo keyword', () => {
    expect(isDemoPvIntent('Build an example quote for a website')).toBe(false);
    expect(isDemoPvIntent('PV stringing for the given hardware')).toBe(false);
    expect(isDemoPvIntent('')).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (1) Demo hardware extraction (only on a demo intent + no real hardware)
// ───────────────────────────────────────────────────────────────────────────

describe('extractStringingInput — demo fallback only explicit, with visible assumptions', () => {
  it('example PV intent without configJson → demo hardware, declared as an assumption', () => {
    const step = makeStep({ title: 'Build an example PV project', skill: 'pv-stringing' });
    const input = extractStringingInput(step);
    expect(input.module?.id).toBe(DEMO_MODULE.id);
    expect(input.inverter?.id).toBe(DEMO_INVERTER.id);
    expect(input.roofPlanes).toHaveLength(1);
    // Each demo value carries a visible "DEMO assumption".
    const reasons = (input.carriedAssumptions ?? []).map((a) => a.reason);
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    expect(reasons.every((r) => /DEMO assumption/.test(r))).toBe(true);
  });

  it('REAL PV intent (no demo keyword) without configJson → honestly empty (no demo guessing)', () => {
    const step = makeStep({ title: 'PV stringing for the given hardware', skill: 'pv-stringing' });
    const input = extractStringingInput(step);
    expect(input.module).toBeUndefined();
    expect(input.inverter).toBeUndefined();
    expect(input.carriedAssumptions).toBeUndefined();
  });

  it('real configJson hardware beats the demo fallback (no overwrite)', () => {
    const step = makeStep({
      title: 'Build an example PV project', // demo keyword present …
      skill: 'pv-stringing',
      config: { module: DEMO_MODULE, inverter: DEMO_INVERTER, roofPlanes: [] },
    });
    const input = extractStringingInput(step);
    // … but because real hardware is in configJson, NO carriedAssumptions.
    expect(input.carriedAssumptions).toBeUndefined();
    expect(input.module?.id).toBe(DEMO_MODULE.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (2)+(3) Demo PV run → complete artifact → LIVE spine hop → G5 PASS
// ───────────────────────────────────────────────────────────────────────────

describe('Demo PV run → G5 PASS from ONE pure PV run', () => {
  const step = makeStep({ title: 'Build an example PV project', skill: 'pv-stringing' });

  it('is a recognized pv-stringing step', () => {
    expect(isPvStringingStep(step)).toBe(true);
  });

  it('producer returns a complete electrical model (modules + strings + inverters + decision)', () => {
    const output = runPvStringingStep(step);
    expect(output).toContain(PV_STRINGING_OUTPUT_MARKER);
    expect(output).toContain('0 (PASS)'); // self-verification: 0 rule violations
    expect(output).toMatch(/DEMO assumption/); // demo hardware visible in the header

    const open = output.indexOf('<pv-stringing-artifact>') + '<pv-stringing-artifact>'.length;
    const close = output.indexOf('</pv-stringing-artifact>');
    const artifact = JSON.parse(output.slice(open, close));
    expect(artifact.surfacePayload.strings.length).toBeGreaterThan(0);
    expect(artifact.surfacePayload.inverters.length).toBeGreaterThan(0);
    // The module object + the stringing-validated decision.
    expect(artifact.surfacePayload.modules.length).toBe(1);
    expect(artifact.surfacePayload.modules[0].id).toBe(DEMO_MODULE.id);
    expect(artifact.decisions).toContain('stringing-validated');
  });

  it('through the REAL spine hop (buildPvDomainEvalFromDecisions) → G5 PASS (stringing-constraint)', () => {
    // Exactly what loadPortfolioRunState reads from workstream_decisions.rationale
    // and turns into state.domainEval — reproduced here without a DB.
    const output = runPvStringingStep(step);
    const rationale = asDecisionRationale(output);

    const domainEval = buildPvDomainEvalFromDecisions([rationale]);
    expect(domainEval).not.toBeNull();
    expect(domainEval!.testCaseId).toBe('stringing-constraint');

    // G5 LIVE over exactly this domainEval (like the spine G5 gate validator).
    const verdict = evaluateArtifact(domainEval!.pvArtifact, getTestCase(domainEval!.testCaseId));
    const gate = toG5GateResult(verdict);
    expect(verdict.passed).toBe(true);
    expect(gate.passed).toBe(true);
    expect(gate.blockingItems).toEqual([]);
    // Verbatim proof that G5 passed for real (not via fallback).
    expect(gate.reason).toMatch(/passed/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// (4) CONTROL: real intent without hardware → honestly BLOCK
// ───────────────────────────────────────────────────────────────────────────

describe('control — real PV intent without hardware stays honestly BLOCK', () => {
  it('no demo keyword, no configJson → empty model → no domainEval (spine fallback)', () => {
    const step = makeStep({ title: 'PV stringing for a real client project', skill: 'pv-stringing' });
    const output = runPvStringingStep(step);
    const rationale = asDecisionRationale(output);

    // Empty electrical model → the hop returns no domainEval → G5 uses the
    // lane-contract fallback instead of producing a fabricated PASS.
    const domainEval = buildPvDomainEvalFromDecisions([rationale]);
    expect(domainEval).toBeNull();
  });

  it('demo hardware ONLY as configJson, but the module is missing → truly empty, no demo fill-in', () => {
    // configJson present, but neither module nor inverter → no hasRealHardware; title
    // without a demo keyword → no demo fallback → honestly empty.
    const step = makeStep({
      title: 'PV stringing real project',
      skill: 'pv-stringing',
      config: { roofPlanes: [] },
    });
    const input = extractStringingInput(step);
    expect(input.module).toBeUndefined();
    expect(input.inverter).toBeUndefined();
  });
});
