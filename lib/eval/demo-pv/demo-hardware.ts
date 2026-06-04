/**
 * Demo PV (photovoltaic) eval · Explicitly declared DEMO hardware
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS (A DEMONSTRABLE RESULT, HONEST)
 * ───────────────────────────────────────────────────
 * Just as a "build a website" run ultimately delivers a viewable page, a
 * "build an EXAMPLE PV project" run should ultimately deliver a checkable PV
 * package that PASSES the G5 domain gate LIVE — without the owner first having
 * to operate a hardware-input surface (that is a documented follow-up slice,
 * NOT here).
 *
 * HONESTY — DEMO IS NOT "GUESSING"
 * ────────────────────────────────
 * For REAL projects the hardware (RoofPlane/module/inverter) stays strictly
 * owner-input-dependent: if it is missing, the producer runs honestly empty and
 * G5 BLOCKs (no-electrical-model). That is intended.
 *
 * ONLY when the intent EXPLICITLY identifies ITSELF as an example/demo/sample
 * (keyword "example" / "demo" / "sample" + PV context) AND no real hardware is
 * present does the system use this DEMO set. It is NOT used silently: each demo
 * hardware item produces a `ProducerAssumption` with the reason "DEMO
 * assumption …", visible in the producer output under `assumptions:[…]`.
 * The owner thus clearly sees that example hardware was used.
 *
 * PHYSICS CONTRACT (deterministically recomputed against producer.ts)
 * ──────────────────────────────────────────────────────────────────
 * The set is chosen so `produceStringingPlan` yields 0 `stringingViolations`
 * (otherwise the demo would be worthless):
 *
 *   Module:   vocStc 41.5 V · vmpStc 34.5 V · tempCoeffVoc −0.25 %/°C
 *   Inverter: maxDcV 600 V · MPPT window [120, 500] V · 2 MPP trackers
 *   Demo Tmin −10 °C -> Uoc(n) = 41.5·n·1.0875 = 45.13·n  -> n ≤ 13 (≤600 V)
 *   Demo Tmax  70 °C, vmpCoeff −0.35 %/°C -> Umpp(n) = 34.5·n·0.8425 = 29.07·n
 *     -> n ≥ 5 (≥120 V) and n ≤ 17 (≤500 V) -> allowed range [5, 13]
 *   Usable modules per roof = 20 -> 1 full string (13) + remainder 7 (≥5) = 2
 *     strings, both in window, on two MPP trackers -> 0 violations -> G5 PASS.
 *
 * These values are realistic datasheet orders of magnitude (a standard 410-Wp
 * glass-glass module + an 8-kW hybrid inverter), NOT fantasy values.
 *
 * DETERMINISTIC (N6): pure data + pure functions, no I/O, no randomness.
 */

import type { Inverter, PvModule, RoofPlane } from './domain-model';
import type { ProducerAssumption, StringingProducerInput } from './producer';

/** Stable ID prefix marking demo artifacts as an example (provenance). */
export const DEMO_ID_PREFIX = 'demo';

/** Demo design temperatures (explicit, visible in the output as an assumption). */
export const DEMO_T_MIN_C = -10;
export const DEMO_T_MAX_C = 70;

/** Usable modules per demo roof plane (deterministic, instead of an area estimate). */
export const DEMO_MODULES_PER_PLANE = 20;

/** Realistic demo PV module (standard 410-Wp glass-glass). */
export const DEMO_MODULE: PvModule = {
  kind: 'module',
  id: 'demo-module-410',
  manufacturer: 'DEMO PV',
  model: 'Example 410 Glass-Glass',
  wattPeak: 410,
  vocStc: 41.5,
  vmpStc: 34.5,
  tempCoeffVocPctPerC: -0.25,
};

/** Realistic demo hybrid inverter (8 kW, 2 MPP trackers). */
export const DEMO_INVERTER: Inverter = {
  kind: 'inverter',
  id: 'demo-inverter-8k',
  manufacturer: 'DEMO Power',
  model: 'Example Hybrid 8.0',
  acNominalPowerW: 8000,
  maxDcPowerW: 12000,
  maxDcVoltageV: 600,
  mpptTrackers: 2,
  mpptVoltageWindowV: { min: 120, max: 500 },
};

/** Realistic demo roof plane (south, 30° tilt, ~35 m² usable). */
export const DEMO_ROOF_PLANE: RoofPlane = {
  kind: 'roof-plane',
  id: 'demo-roof-south',
  buildingId: 'demo-building',
  azimuthDeg: 180,
  tiltDeg: 30,
  areaM2: 42,
  usableAreaM2: 35,
};

/**
 * Builds the full `StringingProducerInput` from the demo hardware. Each demo
 * value is passed through as a visible `ProducerAssumption` (reason containing
 * "DEMO assumption") — the owner sees in the output that example hardware was
 * used. NO silent guessing.
 *
 * Deterministic (N6), never throws.
 */
export function buildDemoStringingInput(): StringingProducerInput {
  const carriedAssumptions: ProducerAssumption[] = [
    {
      field: 'module',
      value: `${DEMO_MODULE.manufacturer} ${DEMO_MODULE.model}`,
      reason:
        'DEMO assumption: no owner-given module — a realistic example module ' +
        '(410 Wp glass-glass) used. For real projects request the module from the owner.',
    },
    {
      field: 'inverter',
      value: `${DEMO_INVERTER.manufacturer} ${DEMO_INVERTER.model}`,
      reason:
        'DEMO assumption: no owner-given inverter — a realistic example ' +
        '(8 kW hybrid, 2 MPP trackers) used. For real projects request it.',
    },
    {
      field: 'roofPlanes',
      value: `${DEMO_ROOF_PLANE.id} (south ${DEMO_ROOF_PLANE.tiltDeg}°, ${DEMO_ROOF_PLANE.usableAreaM2} m²)`,
      reason:
        'DEMO assumption: no owner-given roof plane — a realistic example south ' +
        'plane used. For real projects request the roof measurement from the owner.',
    },
    {
      field: 'modulesPerPlane',
      value: DEMO_MODULES_PER_PLANE,
      reason:
        'DEMO assumption: usable module count per demo roof fixed at 20 ' +
        '(deterministic example layout).',
    },
  ];

  return {
    roofPlanes: [DEMO_ROOF_PLANE],
    module: DEMO_MODULE,
    inverter: DEMO_INVERTER,
    modulesPerPlane: { [DEMO_ROOF_PLANE.id]: DEMO_MODULES_PER_PLANE },
    tMinC: DEMO_T_MIN_C,
    tMaxC: DEMO_T_MAX_C,
    stringIdPrefix: DEMO_ID_PREFIX,
    carriedAssumptions,
  };
}

/**
 * Deterministically detects whether an intent EXPLICITLY identifies ITSELF as
 * an example/demo/sample PV run. Requires BOTH: a demo keyword AND a PV
 * context — so "build an example quote" for another domain does NOT wrongly
 * pull demo PV hardware.
 *
 * The keyword sets keep both English and German tokens so the detector works
 * for either language of operator input.
 *
 * Deterministic (N6), never throws.
 */
export function isDemoPvIntent(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  const hasDemoKeyword = /\b(beispiel|demo|muster|example|sample)\b/i.test(text);
  if (!hasDemoKeyword) return false;
  const hasPvContext =
    /\b(pv|photovoltaik|solar|stringing|string|wechselrichter|inverter|modulbelegung|dachbelegung|pv-?auslegung)\b/i.test(
      text,
    );
  return hasPvContext;
}
