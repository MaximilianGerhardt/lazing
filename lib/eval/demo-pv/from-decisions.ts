/**
 * Demo PV (photovoltaic) eval · Decision-rationale adapter (LIVE hop)
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS (THE MISSING HOP)
 * ──────────────────────────────────────
 * `from-artifact.ts` maps an already-extracted `GenericBuildArtifact` onto a
 * `PvArtifact`. `evaluate.ts` scores G5 against that artifact. The wiring test
 * (`__tests__/wiring.test.ts`) already chains both end-to-end — but ONLY in
 * the test: it calls `runPvStringingStep` directly + parses the output by hand.
 *
 * In the REAL flow, the deterministic pv-stringing producer runs in the
 * execution loop (`lib/workstreams/plan-executor.ts::runPvStringingStep`)
 * and persists its PvArtifact twice:
 *
 *   (a) as step-output text in the in-memory `stepOutputs` list, AND
 *   (b) persistently as a `workstream_decisions` row (decision_kind='route',
 *       actor='policy') whose `rationale` begins with `pv_stringing_producer=true`
 *       and contains the verbatim producer output — including the machine-
 *       readable `<pv-stringing-artifact>{…}</…>` block.
 *
 * The portfolio spine (`lib/portfolio/spine.ts`) scores G5 via
 * `state.domainEval.pvArtifact`. Until now NOBODY populated that field from the
 * persisted producer output -> G5 never ran for real in the actual flow, only
 * in the unit test. This file closes exactly that hop:
 *
 *     workstream_decisions.rationale  (producer output, persisted)
 *         │  parsePvStringingArtifactBlock  (marker extraction)
 *         ▼
 *     GenericBuildArtifact[]  (one per pv-stringing decision)
 *         │  mergeBuildArtifacts  (additive, dedupe)
 *         ▼
 *     mapArtifactToPvArtifact  (from-artifact.ts)
 *         ▼
 *     { pvArtifact, testCaseId }  -> state.domainEval  (G5 LIVE)
 *
 * LAYERING DISCIPLINE
 * ───────────────────
 * This file imports ONLY within `lib/eval/demo-pv/*`. It pulls NO import on
 * `lib/portfolio/*` (the spine imports the eval module, not the reverse) and NO
 * import on `lib/workstreams/plan-executor.ts` (that would be a heavy runtime
 * hang with DB/tmux dependencies in the pure eval layer). The marker string is
 * therefore re-declared locally here — the source of truth stays
 * `PV_STRINGING_OUTPUT_MARKER` in plan-executor.ts; a mismatch would be caught
 * by `__tests__/from-decisions.test.ts` + the wiring test.
 *
 * DETERMINISTIC (N6) + FAIL-SOFT
 * ──────────────────────────────
 * Pure functions, no I/O, idempotent. Any defect (no marker, broken JSON,
 * missing fields) -> empty/partial artifact, NEVER a throw. An empty result
 * (not a single pv-stringing output) -> `null`: the spine then sets NO
 * `domainEval` and G5 stays with the lane-contract fallback — exactly the old
 * behavior (backward compatible).
 */

import type { DomainObjectKind, PvArtifact } from './domain-model';
import { presentObjectKinds } from './domain-model';
import { evaluateArtifact } from './evaluate';
import {
  mapArtifactToPvArtifact,
  type GenericBuildArtifact,
  type GenericDecision,
  type PvSurfacePayload,
} from './from-artifact';
import {
  PV_EVAL_TEST_CASES,
  getTestCase,
  type PvEvalTestCase,
  type TestCaseId,
} from './test-cases';

// ───────────────────────────────────────────────────────────────────────────
// Marker (LOCAL re-declaration — source of truth: PV_STRINGING_OUTPUT_MARKER in
// lib/workstreams/plan-executor.ts; see the layering-discipline note above).
// ───────────────────────────────────────────────────────────────────────────

/** Opening marker of the serialized producer artifact. */
export const PV_STRINGING_ARTIFACT_OPEN = '<pv-stringing-artifact>';
/** Closing marker. */
export const PV_STRINGING_ARTIFACT_CLOSE = '</pv-stringing-artifact>';

/**
 * Prefix with which `plan-executor.ts` writes every pv-stringing producer
 * decision into the `workstream_decisions.rationale`. Used to separate
 * pv-stringing decisions from other `route` decisions (e.g. stage completions).
 */
export const PV_STRINGING_DECISION_PREFIX = 'pv_stringing_producer=true';

// ───────────────────────────────────────────────────────────────────────────
// Marker extraction
// ───────────────────────────────────────────────────────────────────────────

/**
 * Extracts the serialized `GenericBuildArtifact` JSON from ONE text (decision
 * rationale or step output). Returns the parsed object or `null` (no marker /
 * broken JSON). Deterministic, never throws.
 *
 * Deliberately standalone (instead of importing `parsePvStringingOutput` from
 * plan-executor) — see the layering-discipline note in the file header.
 */
export function parsePvStringingArtifactBlock(
  text: unknown,
): GenericBuildArtifact | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf(PV_STRINGING_ARTIFACT_OPEN);
  if (start === -1) return null;
  const from = start + PV_STRINGING_ARTIFACT_OPEN.length;
  const end = text.indexOf(PV_STRINGING_ARTIFACT_CLOSE, from);
  if (end === -1) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(from, end));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as GenericBuildArtifact;
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Additive merge of multiple build artifacts
// ───────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Unions the surface payloads of two artifacts additively. Lists are
 * concatenated; single slots win "first-not-empty" (the first artifact with
 * the slot sets it). Missing slots stay undefined.
 *
 * The `mapArtifactToPvArtifact` adapter then deduplicates by `kind`+`id`, so
 * double counting is harmless.
 */
function mergeSurfacePayloads(
  a: PvSurfacePayload | undefined,
  b: PvSurfacePayload | undefined,
): PvSurfacePayload | undefined {
  if (!isRecord(a)) return isRecord(b) ? b : undefined;
  if (!isRecord(b)) return a;

  const listKeys: Array<keyof PvSurfacePayload> = [
    'roofPlanes',
    'obstructions',
    'modules',
    'strings',
    'inverters',
    'batteries',
    'simulationRuns',
    'quotes',
    'approvals',
    'crmSyncEvents',
  ];
  const singleKeys: Array<keyof PvSurfacePayload> = [
    'lead',
    'building',
    'consumptionProfile',
    'simulation',
    'quote',
    'approval',
    'crmSync',
  ];

  const out: PvSurfacePayload = {};
  for (const k of listKeys) {
    const merged = [...asArray((a as PvSurfacePayload)[k]), ...asArray((b as PvSurfacePayload)[k])];
    if (merged.length > 0) (out as Record<string, unknown>)[k] = merged;
  }
  for (const k of singleKeys) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    const chosen = av !== undefined && av !== null ? av : bv;
    if (chosen !== undefined && chosen !== null) {
      (out as Record<string, unknown>)[k] = chosen;
    }
  }
  return out;
}

/**
 * Unions multiple `GenericBuildArtifact` additively into ONE. All sources
 * contribute: domainObjects + surfacePayload lists + decisions + flowSteps are
 * concatenated. This way the electrical model from the pv-stringing producer
 * (strings/inverters) merges with any further run artifacts (e.g. an upstream
 * roof/lead/quote output, or grantsDecisionsOnApprove decisions from the
 * expert gate) into ONE eval input.
 *
 * Deterministic (N6), fail-soft.
 */
export function mergeBuildArtifacts(
  artifacts: ReadonlyArray<GenericBuildArtifact | null | undefined>,
): GenericBuildArtifact {
  const merged: GenericBuildArtifact = {};
  const domainObjects: unknown[] = [];
  const decisions: Array<GenericDecision | string> = [];
  const flowSteps: NonNullable<GenericBuildArtifact['flowSteps']> = [];
  let surface: PvSurfacePayload | undefined;

  for (const art of artifacts) {
    if (!isRecord(art)) continue;
    domainObjects.push(...asArray((art as GenericBuildArtifact).domainObjects));
    decisions.push(
      ...asArray<GenericDecision | string>((art as GenericBuildArtifact).decisions),
    );
    flowSteps.push(
      ...asArray<NonNullable<GenericBuildArtifact['flowSteps']>[number]>(
        (art as GenericBuildArtifact).flowSteps,
      ),
    );
    surface = mergeSurfacePayloads(surface, (art as GenericBuildArtifact).surfacePayload);
  }

  if (domainObjects.length > 0) merged.domainObjects = domainObjects;
  if (decisions.length > 0) merged.decisions = decisions;
  if (flowSteps.length > 0) merged.flowSteps = flowSteps;
  if (surface) merged.surfacePayload = surface;
  return merged;
}

/**
 * Is this merged artifact completely empty (no domain substrate at all)?
 * An empty artifact -> no `domainEval` (G5 stays with the fallback).
 */
function isEmptyBuildArtifact(art: GenericBuildArtifact): boolean {
  const sp = art.surfacePayload;
  const surfaceEmpty =
    !isRecord(sp) ||
    Object.values(sp as Record<string, unknown>).every(
      (v) => v === undefined || v === null || (Array.isArray(v) && v.length === 0),
    );
  return (
    asArray(art.domainObjects).length === 0 &&
    asArray(art.decisions).length === 0 &&
    asArray(art.flowSteps).length === 0 &&
    surfaceEmpty
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Test case selection
// ───────────────────────────────────────────────────────────────────────────

/**
 * Default test case for a pure pv-stringing run: the narrowest PV domain model
 * that requires exactly the producer contribution (module/string/inverter +
 * stringing-validated). A pure roof/lead output without an electrical model
 * fails here deterministically (no-electrical-model) — exactly the anti-MVP
 * proof.
 */
export const DEFAULT_PV_TEST_CASE_ID: TestCaseId = 'stringing-constraint';

/**
 * Order in which we check cases for "fully satisfied" — from broad to narrow.
 * We pick the MOST DEMANDING case the artifact fully passes; that is the most
 * honest G5 yardstick (an artifact that passes `simple-roof` is more than one
 * that only passes `stringing-constraint`).
 */
const TEST_CASE_PREFERENCE: readonly TestCaseId[] = [
  'tool-replacement',
  'complex-roof',
  'simple-roof',
  'storage-sizing',
  'crm-handoff',
  'expert-gate',
  'stringing-constraint',
];

function caseObjectKinds(tc: PvEvalTestCase): Set<DomainObjectKind> {
  return new Set(tc.requiredDomainObjects);
}

/**
 * Deterministically picks the test case for a merged PV artifact:
 *
 *   1. The most demanding case (per TEST_CASE_PREFERENCE) the artifact FULLY
 *      passes (evaluateArtifact.passed) — this makes G5 a REAL PASS when the
 *      domain model is genuinely deep enough.
 *   2. Otherwise: the narrowest case whose required object kinds are a SUBSET
 *      of the present kinds (fitting yardstick, even if it still BLOCKs — e.g.
 *      due to a missing decision; G5 then shows the real gaps instead of
 *      picking an ill-fitting case).
 *   3. Otherwise: `DEFAULT_PV_TEST_CASE_ID` (`stringing-constraint`) — the pure
 *      producer yardstick; an artifact without an electrical model fails here
 *      correctly (no-electrical-model), no fabricated PASS.
 *
 * Deterministic (N6), never throws.
 */
export function pickTestCaseForArtifact(pv: PvArtifact): TestCaseId {
  // (1) Most demanding fully-passed case.
  for (const id of TEST_CASE_PREFERENCE) {
    try {
      const verdict = evaluateArtifact(pv, getTestCase(id));
      if (verdict.passed) return id;
    } catch {
      /* fail-soft: broken case -> skip */
    }
  }

  // (2) Narrowest case whose object kinds are fully present.
  const present = presentObjectKinds(pv);
  let best: { id: TestCaseId; size: number } | null = null;
  for (const tc of PV_EVAL_TEST_CASES) {
    const kinds = caseObjectKinds(tc);
    let allPresent = true;
    for (const k of kinds) {
      if (!present.has(k)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent && (best === null || kinds.size > best.size)) {
      best = { id: tc.id, size: kinds.size };
    }
  }
  if (best) return best.id;

  // (3) Default yardstick.
  return DEFAULT_PV_TEST_CASE_ID;
}

// ───────────────────────────────────────────────────────────────────────────
// Main entry: from decision rationales -> domain-eval context
// ───────────────────────────────────────────────────────────────────────────

/**
 * What the spine hangs on `state.domainEval`: a mapped `PvArtifact` plus the
 * armed test case. `pvArtifact` is declared as `unknown` because
 * `lib/portfolio/types.ts::DomainEvalContext.pvArtifact` is (deliberately)
 * `unknown` — the spine casts back at eval time.
 */
export interface PvDomainEval {
  pvArtifact: PvArtifact;
  testCaseId: TestCaseId;
}

/**
 * THE LIVE HOP. Takes the rationales of all pv-relevant `route` decisions of a
 * run (the way `loadPortfolioRunState` reads them from `workstream_decisions`)
 * and builds a `PvDomainEval` context from them.
 *
 * Optional `extraArtifacts`: already-extracted build artifacts from other
 * sources (e.g. the in-memory `stepOutputs` list of a running plan). They are
 * unioned additively with the ones parsed from the rationales.
 *
 * RETURNS:
 *   - `null` when NO pv-stringing artifact was found (no marker in any
 *     rationale, no extra artifacts) OR the merged artifact is empty -> the
 *     spine then sets no `domainEval`, G5 stays with the fallback (backward
 *     compatible).
 *   - otherwise `{ pvArtifact, testCaseId }` for `state.domainEval`.
 *
 * Deterministic (N6), fail-soft — never throws.
 */
export function buildPvDomainEvalFromDecisions(
  rationales: ReadonlyArray<string | null | undefined>,
  extraArtifacts: ReadonlyArray<GenericBuildArtifact | null | undefined> = [],
): PvDomainEval | null {
  const parsed: GenericBuildArtifact[] = [];

  for (const r of rationales ?? []) {
    const art = parsePvStringingArtifactBlock(r);
    if (art) parsed.push(art);
  }

  const all = [...parsed, ...(extraArtifacts ?? [])].filter(isRecord);
  if (all.length === 0) return null;

  const merged = mergeBuildArtifacts(all);
  if (isEmptyBuildArtifact(merged)) return null;

  const pvArtifact = mapArtifactToPvArtifact(merged);
  // A mapped artifact with no domain object AND no decision carries no
  // evaluable substance -> no domainEval (fallback).
  if (pvArtifact.objects.length === 0 && pvArtifact.expertDecisions.length === 0) {
    return null;
  }

  const testCaseId = pickTestCaseForArtifact(pvArtifact);
  return { pvArtifact, testCaseId };
}
