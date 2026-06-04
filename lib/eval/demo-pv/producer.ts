/**
 * Demo PV (photovoltaic) regression eval · Stringing producer
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The domain model (`domain-model.ts`) carries the deterministic domain rule
 * `stringingViolations` (Uoc(Tmin) <= inverter maxDcV, Umpp(Tmax) in MPPT window).
 * The evaluator (`evaluate.ts`) flips the G5 gate to BLOCK as soon as a
 * `PvArtifact` carries no electrical model (`only-roof-drawer` /
 * `no-electrical-model`) or violates the stringing rule
 * (`stringing-rule-violated`). The adapter (`from-artifact.ts`) maps a generic
 * build output fail-soft onto a `PvArtifact`.
 *
 * What used to be MISSING: a PRODUCER that actually GENERATES the electrical
 * model — i.e. `PvString[]` (+ a `GenericBuildArtifact` with filled
 * `surfacePayload.strings[]/inverters[]`) computed so the ALREADY-CODED rule
 * `stringingViolations` passes without violation.
 *
 * DESIGN PRINCIPLE: PURE PHYSICS AGAINST THE EXISTING RULE — NO DOMAIN VERDICT
 * ───────────────────────────────────────────────────────────────────────────
 * `produceStringingPlan` is a deterministic, purely arithmetic solver
 * (N6: no LLM, no I/O, no randomness, idempotent). It does NOT INVENT
 * hardware: module + inverter + roof planes are GIVEN (input). It makes NO
 * domain verdict (no shading assessment, no structural sign-off). It only
 * computes the module count per string so the temperature/voltage physics
 * fits into the stringing window spanned by the inverter — exactly the
 * quantities that `stringingViolations` checks.
 *
 * HONESTY: WHERE DATA IS MISSING, LEAVE IT EMPTY — DON'T GUESS
 * ───────────────────────────────────────────────────────────
 * If an input is missing (no inverter, no module, no roof plane, or NO valid
 * module count can be found), the solver produces NO strings for that case
 * (empty set / omitted roof plane) and reports the reason verbatim in `notes`.
 * It fills nothing with default hardware. An honestly empty electrical model
 * then fails correctly in `evaluate.ts` at the
 * `only-roof-drawer`/`no-electrical-model` blocker — that is intended, not a bug.
 *
 * TEMPERATURE PHYSICS (deterministic, against the coded rule)
 * ──────────────────────────────────────────────────────────
 *   Uoc(Tmin) = vocStc × n × (1 + (tempCoeffVocPctPerC/100) × (Tmin − 25))
 *   Umpp(Tmax) = vmpStc × n × (1 + (vmpTempCoeffPctPerC/100) × (Tmax − 25))
 *
 * At Tmin < 25 °C, Uoc rises (tempCoeffVoc is negative, (Tmin−25) negative ->
 * product positive -> factor > 1) — that is the critical load case against
 * `inverter.maxDcVoltageV`. At Tmax > 25 °C, Umpp drops — that is the critical
 * load case against `mpptVoltageWindowV.min`.
 *
 * HONEST GAP in the domain model: `PvModule` carries `tempCoeffVocPctPerC` but
 * NO Vmp temperature coefficient. We do NOT silently guess it; instead we take
 * it as a NAMED, documented input parameter (`vmpTempCoeffPctPerC`) with an
 * explicit, conservative default (`DEFAULT_VMP_TEMP_COEFF_PCT_PER_C`). The
 * default is visible in the output via `assumptions` — the owner/expert sees
 * which assumption was used and can override it (expert-gate). Vmp and Voc
 * physically share the same sign; the Vmp coefficient is typically slightly
 * larger in magnitude than the Voc coefficient (datasheet rule of thumb
 * ~ −0.30…−0.40 %/°C for crystalline silicon).
 */

import {
  stringingViolations,
  type Inverter,
  type PvModule,
  type PvString,
  type RoofPlane,
} from './domain-model';
import type { GenericBuildArtifact } from './from-artifact';

// ───────────────────────────────────────────────────────────────────────────
// Deterministic standard design temperatures (DIN/VDE-typical limits).
// Exported as named constants so tests/owner can override them.
// ───────────────────────────────────────────────────────────────────────────

/** Coldest design case (°C) — drives the Uoc extrapolation (max DC voltage). */
export const DEFAULT_T_MIN_C = -10;

/** Hottest module design case (°C) — drives the Umpp extrapolation (MPPT min). */
export const DEFAULT_T_MAX_C = 70;

/**
 * Conservative Vmp temperature coefficient (%/°C), USED ONLY when the `PvModule`
 * carries none of its own (the domain model currently carries none). Negative;
 * slightly larger in magnitude than a typical Voc coefficient. EXPLICITLY
 * visible in the output (`assumptions`) — no hidden guessing.
 */
export const DEFAULT_VMP_TEMP_COEFF_PCT_PER_C = -0.35;

/**
 * The expert-decision ID the producer sets WHEN its own arithmetic stringing
 * contract is satisfied (0 `stringingViolations`). Exactly this ID is required
 * by the `stringing-constraint` test case (`requiredExpertDecisions`) and it is
 * part of the `simple-roof`/`complex-roof`/`tool-replacement` claim. It attests
 * NO domain verdict about shading/structural check (that stays the expert
 * gate), only the deterministically recomputed voltage/MPPT conformity.
 */
export const PV_STRINGING_VALIDATED_DECISION = 'stringing-validated';

// ───────────────────────────────────────────────────────────────────────────
// Producer input/output
// ───────────────────────────────────────────────────────────────────────────

/**
 * Input of the stringing producer. EVERYTHING is given — the solver invents no
 * hardware.
 */
export interface StringingProducerInput {
  /** Given roof plane(s) — one orientation per string, hence solved per plane. */
  roofPlanes: RoofPlane[];
  /** The chosen PV module (given). */
  module: PvModule;
  /** The chosen inverter (given) — spans the stringing window. */
  inverter: Inverter;
  /**
   * Optional: usable module count per roof plane (e.g. from an area/layout
   * calculation). If missing, the solver derives a rough upper bound from
   * `usableAreaM2` (see `MODULE_FOOTPRINT_M2`); if that is also unavailable,
   * the roof plane is left out (honestly empty).
   */
  modulesPerPlane?: Record<string, number>;
  /** Design temperatures — default DIN-typical, overridable. */
  tMinC?: number;
  tMaxC?: number;
  /**
   * Vmp temperature coefficient (%/°C). If missing, the documented default is
   * used and reported in `assumptions`.
   */
  vmpTempCoeffPctPerC?: number;
  /** ID prefix for generated strings (determinism + provenance). */
  stringIdPrefix?: string;
  /**
   * Upfront assumptions made by the CALLER that should stay visible in the
   * output — e.g. the explicitly declared demo hardware of an example PV run
   * (`extractStringingInput`). Honesty: do NOT silently guess, pass through as
   * a named assumption. They are prepended to the producer's own assumptions
   * (order: caller assumptions first).
   */
  carriedAssumptions?: ProducerAssumption[];
}

/** An assumption made — makes implicit defaults visible in the output. */
export interface ProducerAssumption {
  field: string;
  value: number | string;
  reason: string;
}

/** An omitted input + verbatim reason (honestly empty, no guessing). */
export interface ProducerOmission {
  roofPlaneId: string | null;
  reason: string;
}

export interface StringingProducerResult {
  /** The generated strings, validated against `stringingViolations`. */
  strings: PvString[];
  /**
   * A build artifact directly dockable to `from-artifact.ts`: `inverters[]`
   * (the given inverter) + `strings[]` (the computed strings). Exactly these
   * fields make the `only-roof-drawer` / `no-electrical-model` blockers in
   * `evaluate.ts` NO longer trip.
   */
  artifact: GenericBuildArtifact;
  /** Default assumptions made (e.g. Vmp coefficient, Tmin/Tmax). */
  assumptions: ProducerAssumption[];
  /** Omitted roof planes + reason (no valid layout / missing data). */
  omissions: ProducerOmission[];
  /**
   * Self-verification: the result of `stringingViolations` over the generated
   * model. MUST be empty when `strings.length > 0`. Makes the "computes against
   * the existing rule" contract checkable in the output.
   */
  ruleViolations: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// Helper constants + arithmetic
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rough module footprint (m²) for the upper-bound estimate from `usableAreaM2`,
 * USED ONLY when `modulesPerPlane` is missing. Conservative (standard module
 * ~1.7 m² + row spacing). Visible as an assumption in the output.
 */
export const MODULE_FOOTPRINT_M2 = 2.0;

/** Uoc of an n-module string at the coldest design case (V). */
export function vocAtTmin(module: PvModule, moduleCount: number, tMinC: number): number {
  const deltaT = tMinC - 25;
  const factor = 1 + (module.tempCoeffVocPctPerC / 100) * deltaT;
  return module.vocStc * moduleCount * factor;
}

/** Umpp of an n-module string at the hottest design case (V). */
export function vmpAtTmax(
  module: PvModule,
  moduleCount: number,
  tMaxC: number,
  vmpTempCoeffPctPerC: number,
): number {
  const deltaT = tMaxC - 25;
  const factor = 1 + (vmpTempCoeffPctPerC / 100) * deltaT;
  return module.vmpStc * moduleCount * factor;
}

/** Rounds to 1 decimal place (stable, readable voltage values; deterministic). */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Determines the allowed module-count range [min,max] per string from physics:
 *   • max: largest n with Uoc(Tmin) <= inverter.maxDcVoltageV  (cold limit)
 *   • min: smallest n with Umpp(Tmax) >= mpptVoltageWindowV.min (hot limit)
 * In addition, Umpp(Tmax) of the chosen n must not exceed the MPPT maximum
 * (rarely binding, but checked by the rule).
 * Returns null when no n satisfies both bounds (honestly: not solvable).
 */
export function feasibleModuleCountRange(
  module: PvModule,
  inverter: Inverter,
  tMinC: number,
  tMaxC: number,
  vmpTempCoeffPctPerC: number,
): { min: number; max: number } | null {
  // Largest n under the cold DC voltage limit.
  let nMaxByVoc = 0;
  for (let n = 1; n <= 60; n++) {
    if (vocAtTmin(module, n, tMinC) <= inverter.maxDcVoltageV) nMaxByVoc = n;
    else break;
  }
  if (nMaxByVoc === 0) return null; // even 1 module blows the DC limit.

  // Smallest n whose hot Umpp does NOT fall below the MPPT minimum …
  // … and whose hot Umpp does not exceed the MPPT maximum.
  let feasibleMin: number | null = null;
  let feasibleMax: number | null = null;
  for (let n = 1; n <= nMaxByVoc; n++) {
    const umpp = vmpAtTmax(module, n, tMaxC, vmpTempCoeffPctPerC);
    const inWindow =
      umpp >= inverter.mpptVoltageWindowV.min && umpp <= inverter.mpptVoltageWindowV.max;
    if (inWindow) {
      if (feasibleMin === null) feasibleMin = n;
      feasibleMax = n;
    }
  }
  if (feasibleMin === null || feasibleMax === null) return null;
  return { min: feasibleMin, max: feasibleMax };
}

// ───────────────────────────────────────────────────────────────────────────
// Main producer
// ───────────────────────────────────────────────────────────────────────────

/**
 * Generates a valid stringing layout (deterministic, purely arithmetic)
 * against the already-coded rule `stringingViolations`.
 *
 * Strategy per roof plane (one orientation per string):
 *   1. Determine the physically allowed module-count range [min,max].
 *   2. Choose the largest allowed module count that does NOT require more
 *      modules than fit on the plane (maximize utilization without guessing).
 *   3. Generate as many full strings as usable modules / module count yield,
 *      distributed across the inverter's MPPT trackers (round-robin).
 * If the plane is not enough for one full string, the plane is OMITTED
 * (omission) — no partial string below the MPPT minimum (that would violate
 * the rule).
 *
 * @returns strings + dockable artifact + visible assumptions/omissions +
 *          self-verification (`ruleViolations` must be empty when strings>0).
 */
export function produceStringingPlan(
  input: StringingProducerInput,
): StringingProducerResult {
  // Caller assumptions (e.g. explicitly declared demo hardware) first —
  // they stay visible in the output (no silent guessing).
  const assumptions: ProducerAssumption[] = Array.isArray(input.carriedAssumptions)
    ? [...input.carriedAssumptions]
    : [];
  const omissions: ProducerOmission[] = [];

  const tMinC = input.tMinC ?? DEFAULT_T_MIN_C;
  const tMaxC = input.tMaxC ?? DEFAULT_T_MAX_C;
  if (input.tMinC === undefined) {
    assumptions.push({
      field: 'tMinC',
      value: tMinC,
      reason: 'No design Tmin given — DIN-typical cold case assumed.',
    });
  }
  if (input.tMaxC === undefined) {
    assumptions.push({
      field: 'tMaxC',
      value: tMaxC,
      reason: 'No design Tmax given — DIN-typical module hot case assumed.',
    });
  }

  const vmpCoeff = input.vmpTempCoeffPctPerC ?? DEFAULT_VMP_TEMP_COEFF_PCT_PER_C;
  if (input.vmpTempCoeffPctPerC === undefined) {
    assumptions.push({
      field: 'vmpTempCoeffPctPerC',
      value: vmpCoeff,
      reason:
        'PvModule carries no Vmp temperature coefficient — conservative ' +
        'default assumed (NOT guessed, but explicitly declared).',
    });
  }

  const idPrefix = input.stringIdPrefix ?? 'str';

  // (0) Check inputs — if something is missing, honestly empty (no default-hardware guessing).
  const emptyArtifact = (): GenericBuildArtifact => ({
    surfacePayload: { inverters: [], strings: [] },
  });

  if (!input.inverter || typeof input.inverter !== 'object') {
    omissions.push({ roofPlaneId: null, reason: 'No inverter given — no stringing possible.' });
    return { strings: [], artifact: emptyArtifact(), assumptions, omissions, ruleViolations: [] };
  }
  if (!input.module || typeof input.module !== 'object') {
    omissions.push({ roofPlaneId: null, reason: 'No module given — no stringing possible.' });
    return { strings: [], artifact: emptyArtifact(), assumptions, omissions, ruleViolations: [] };
  }
  const roofPlanes = Array.isArray(input.roofPlanes) ? input.roofPlanes : [];
  if (roofPlanes.length === 0) {
    omissions.push({ roofPlaneId: null, reason: 'No roof plane given — no stringing possible.' });
    return { strings: [], artifact: emptyArtifact(), assumptions, omissions, ruleViolations: [] };
  }

  // (1) Physically allowed module-count range (same for all planes —
  //     depends only on module + inverter + temperatures).
  const range = feasibleModuleCountRange(input.module, input.inverter, tMinC, tMaxC, vmpCoeff);
  if (range === null) {
    omissions.push({
      roofPlaneId: null,
      reason:
        'No module count simultaneously satisfies the DC voltage limit (cold) and ' +
        'the MPPT window (hot) for this module/inverter combination.',
    });
    return { strings: [], artifact: emptyArtifact(), assumptions, omissions, ruleViolations: [] };
  }

  // (2) Build strings per roof plane.
  const strings: PvString[] = [];
  const trackerCount = Math.max(1, input.inverter.mpptTrackers);
  let mpptCursor = 0;
  let stringSeq = 0;

  for (const plane of roofPlanes) {
    if (typeof plane !== 'object' || plane === null || typeof plane.id !== 'string') {
      omissions.push({ roofPlaneId: null, reason: 'Roof plane without a valid id — omitted.' });
      continue;
    }

    // Determine usable module count: explicitly given > estimated from area >
    // missing (then honestly omit).
    let capacity: number | null = null;
    if (input.modulesPerPlane && typeof input.modulesPerPlane[plane.id] === 'number') {
      capacity = Math.floor(input.modulesPerPlane[plane.id]);
    } else if (typeof plane.usableAreaM2 === 'number' && plane.usableAreaM2 > 0) {
      capacity = Math.floor(plane.usableAreaM2 / MODULE_FOOTPRINT_M2);
      assumptions.push({
        field: `modulesPerPlane[${plane.id}]`,
        value: capacity,
        reason: `Usable module count estimated from usableAreaM2 (${plane.usableAreaM2} m² / ${MODULE_FOOTPRINT_M2} m²/module).`,
      });
    } else {
      omissions.push({
        roofPlaneId: plane.id,
        reason: 'Neither modulesPerPlane nor usableAreaM2 given — layout not derivable, plane omitted (no guessing).',
      });
      continue;
    }

    if (capacity < range.min) {
      omissions.push({
        roofPlaneId: plane.id,
        reason: `Usable modules (${capacity}) < smallest allowed string (${range.min}) — no valid string possible, plane omitted.`,
      });
      continue;
    }

    // Largest allowed module count that fits the capacity (maximize utilization).
    const perString = Math.min(range.max, capacity);
    const fullStrings = Math.floor(capacity / perString);

    for (let i = 0; i < fullStrings; i++) {
      const mpptInputIndex = mpptCursor % trackerCount;
      mpptCursor++;
      stringSeq++;
      const voc = round1(vocAtTmin(input.module, perString, tMinC));
      const vmp = round1(vmpAtTmax(input.module, perString, tMaxC, vmpCoeff));
      strings.push({
        kind: 'string',
        id: `${idPrefix}-${stringSeq}`,
        roofPlaneId: plane.id,
        moduleId: input.module.id,
        moduleCount: perString,
        inverterId: input.inverter.id,
        mpptInputIndex,
        voltageWindowV: { vocAtTmin: voc, vmpAtTmax: vmp },
      });
    }

    const remainder = capacity - fullStrings * perString;
    if (remainder >= range.min) {
      // The remainder is enough for one more allowed string.
      const mpptInputIndex = mpptCursor % trackerCount;
      mpptCursor++;
      stringSeq++;
      const voc = round1(vocAtTmin(input.module, remainder, tMinC));
      const vmp = round1(vmpAtTmax(input.module, remainder, tMaxC, vmpCoeff));
      strings.push({
        kind: 'string',
        id: `${idPrefix}-${stringSeq}`,
        roofPlaneId: plane.id,
        moduleId: input.module.id,
        moduleCount: remainder,
        inverterId: input.inverter.id,
        mpptInputIndex,
        voltageWindowV: { vocAtTmin: voc, vmpAtTmax: vmp },
      });
    } else if (remainder > 0) {
      omissions.push({
        roofPlaneId: plane.id,
        reason: `Remaining capacity ${remainder} modules < smallest allowed string (${range.min}) — not used (no below-MPPT partial string).`,
      });
    }
  }

  // (3) Self-verification against the existing rule (make the contract checkable).
  //     BEFORE building the artifact, because the COMPLETE electrical model
  //     (incl. `module` object + `stringing-validated` decision) may only be
  //     serialized when the physics truly passes cleanly (0 violations).
  const ruleViolations = stringingViolations({
    objects: strings.length > 0 ? [input.inverter, ...strings] : [],
    expertDecisions: [],
  });

  // (4) Assemble the dockable artifact.
  //
  // The block used to carry ONLY `inverters[]` + `strings[]`. That left the
  // spine G5 hop for the `stringing-constraint` case missing TWO things: the
  // `module` object (requiredDomainObject + part of `no-electrical-model`) AND
  // the `stringing-validated` decision (requiredExpertDecision). Result: G5
  // BLOCKed even for a physically flawless stringing run.
  //
  // FIX (additive, honest): with 0 stringing-rule violations AND real strings,
  // we ALSO write the `module` object (the GIVEN module, not an invented one)
  // into `surfacePayload.modules[]` and record the deterministically justified
  // decision `stringing-validated`. The system thereby makes NO domain verdict
  // it is not entitled to — the decision attests exactly the arithmetic
  // self-verification contract (Uoc(Tmin) <= maxDc, Umpp(Tmax) in the MPPT
  // window) proven by `ruleViolations.length === 0`. With violations OR 0
  // strings, the model stays honestly incomplete -> G5 blocks correctly.
  const electricalComplete = strings.length > 0 && ruleViolations.length === 0;

  const artifact: GenericBuildArtifact = {
    surfacePayload: {
      modules: electricalComplete ? [input.module] : [],
      inverters: strings.length > 0 ? [input.inverter] : [],
      strings,
    },
    ...(electricalComplete ? { decisions: [PV_STRINGING_VALIDATED_DECISION] } : {}),
  };

  return { strings, artifact, assumptions, omissions, ruleViolations };
}

// ───────────────────────────────────────────────────────────────────────────
// Expert-gate preparation (deterministic payload generation)
// ════════════════════════════════════════════════════════════════════════
//
// `domain-model.ts` Approval requires `expertReviewed:true` for
// `grade:'install'`. The evaluator blocker `expert-review-optional`
// (`evaluate.ts`) fires when an install-grade approval is present without review.
//
// This function generates — PURELY DETERMINISTICALLY — the `human-decision`
// gate payload that an owner/expert is shown WHEN install grade is requested
// without `expertReviewed`. Only payload + data type; the UI/ActionDeck wiring
// is done elsewhere (see integration point below).
// ───────────────────────────────────────────────────────────────────────────

/**
 * What inputs does the gate need? Exactly those that make the approval rule
 * load-bearing: the requested grade + whether an expert already reviewed +
 * (for display) what should be checked.
 */
export interface ExpertGateInput {
  /** Which grade is requested. Only 'install' triggers the gate. */
  requestedGrade: 'sales' | 'proposal' | 'install';
  /** Is an expert already involved? true -> no gate needed. */
  expertReviewed: boolean;
  /** Provenance: which quote/approval the sign-off attaches to. */
  quoteId?: string;
  approvalId?: string;
  /** What should be checked (displayed in the gate) — e.g. ['string-layout','structural-check']. */
  reviewItems?: string[];
}

/**
 * The gate payload rendered by the ActionDeck/`executeGateAction` path.
 * `kind:'human-decision'` is the discriminating marker for the gate renderer.
 */
export interface HumanDecisionGatePayload {
  kind: 'human-decision';
  /** Unique gate type — the renderer/router switches on it. */
  gateId: 'expert-review-install-grade';
  /** Verbatim reason why the human is asked (N8, owner-readable). */
  reason: string;
  /** Provenance for later persistence (workstream_decisions). */
  quoteId: string | null;
  approvalId: string | null;
  /** The domain check points the expert should sign off. */
  reviewItems: string[];
  /**
   * The decision ID the system sets WHEN the expert approves. Exactly these IDs
   * are expected by the test cases (`expert-reviewed`/`statics-checked`) and
   * they clear `expert-review-optional` in the eval.
   */
  grantsDecisionsOnApprove: string[];
  /** Which field on the approval object to set to true (provenance). */
  setsFieldOnApprove: { object: 'approval'; field: 'expertReviewed'; value: true };
}

/**
 * Deterministically generates the gate payload WHEN an expert review is needed
 * (install grade without `expertReviewed`). Otherwise `null` (no gate).
 *
 * DETERMINISTIC (N6): pure function, no I/O. Honest: the system COMPUTES the
 * physics (producer) but does NOT sign off on the domain itself — the sign-off
 * is an owner/expert decision over exactly this payload.
 *
 * @returns gate payload or null (when not install grade OR already reviewed).
 */
export function buildExpertReviewGate(
  input: ExpertGateInput,
): HumanDecisionGatePayload | null {
  if (input.requestedGrade !== 'install') return null;
  if (input.expertReviewed === true) return null;

  const reviewItems =
    Array.isArray(input.reviewItems) && input.reviewItems.length > 0
      ? input.reviewItems
      : ['string-layout', 'structural-check'];

  return {
    kind: 'human-decision',
    gateId: 'expert-review-install-grade',
    reason:
      'Install grade requires a domain-expert review (string layout + structural check). ' +
      'The system has computed the stringing physics, but does NOT sign off on the ' +
      'installation itself — please approve as an expert.',
    quoteId: input.quoteId ?? null,
    approvalId: input.approvalId ?? null,
    reviewItems,
    grantsDecisionsOnApprove: ['expert-reviewed', 'statics-checked'],
    setsFieldOnApprove: { object: 'approval', field: 'expertReviewed', value: true },
  };
}
