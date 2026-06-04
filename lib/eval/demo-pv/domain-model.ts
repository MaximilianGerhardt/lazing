/**
 * Demo PV (photovoltaic) regression eval · Domain model
 * ════════════════════════════════════════════════════════════════════════
 *
 * Anti-MVP core:
 *   "A system that only builds a surface here, without compiling domain rules
 *    and expert decisions, fails the gate."
 *
 * This file is the *checkable domain model* for the lead-to-technical-design
 * workflow of a PV project package. The 13 domain objects are NOT empty
 * marker interfaces — each carries the domain-load-bearing fields that
 * distinguish "real expertise compiled" from "just a roof drawer":
 *
 *   • RoofPlane:  azimuth/tilt/area  -> without these no shading/yield
 *                 calculation is possible (blocker: "only roof drawer").
 *   • String:     moduleCount + mpptInput + voltageWindow -> stringing rule
 *                 (Uoc at Tmin <= inverter max DC voltage; Umpp at Tmax >=
 *                 MPPT min). Without this object the plan is blocked
 *                 ("no stringing/inverter/storage model").
 *   • Inverter:   mpptTrackers + maxDcVoltage + maxDcPower -> defines the
 *                 stringing envelope.
 *   • Battery:    usableKwh + charge/discharge strategy -> storage sizing.
 *   • Approval:   grade = sales|proposal|install -> the distinction whose
 *                 absence is a blocker ("no distinction between sales/
 *                 proposal/install grade").
 *
 * The 13 objects are typed via `DomainObjectKind`; a build artifact
 * (see types/PvArtifact) is a collection of instantiated objects + the
 * expert decisions that were taken.
 */

// ───────────────────────────────────────────────────────────────────────────
// Object kinds (exactly 13)
// ───────────────────────────────────────────────────────────────────────────

export type DomainObjectKind =
  | 'lead'
  | 'building'
  | 'roof-plane'
  | 'obstruction'
  | 'module'
  | 'string'
  | 'inverter'
  | 'battery'
  | 'consumption-profile'
  | 'simulation-run'
  | 'quote'
  | 'approval'
  | 'crm-sync-event';

export const DOMAIN_OBJECT_KINDS: readonly DomainObjectKind[] = [
  'lead',
  'building',
  'roof-plane',
  'obstruction',
  'module',
  'string',
  'inverter',
  'battery',
  'consumption-profile',
  'simulation-run',
  'quote',
  'approval',
  'crm-sync-event',
] as const;

// ───────────────────────────────────────────────────────────────────────────
// 1. Lead
// ───────────────────────────────────────────────────────────────────────────

export type LeadSource = 'web-form' | 'phone' | 'partner' | 'referral' | 'import';

export interface Lead {
  kind: 'lead';
  id: string;
  source: LeadSource;
  /** Full address — load-bearing for geo/irradiation region. */
  addressLine: string;
  postalCode: string;
  /** Owner vs. tenant: determines whether installation is allowed at all. */
  isPropertyOwner: boolean;
  /** Rough demand in kWh/year (may later be replaced by the consumption profile). */
  annualConsumptionKwhEstimate: number | null;
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Building
// ───────────────────────────────────────────────────────────────────────────

export type RoofType = 'gable' | 'hip' | 'flat' | 'shed' | 'mansard' | 'complex';

export interface Building {
  kind: 'building';
  id: string;
  leadId: string;
  roofType: RoofType;
  /** Number of distinct roof planes — >1 forces multiple RoofPlanes (complex-roof case). */
  roofPlaneCount: number;
  /** Roof covering determines the mounting system (tile/trapezoidal sheet/bitumen…). */
  roofCovering: string;
  /** Eave/ridge height in m — scaffolding/safety relevance for install grade. */
  eaveHeightM: number;
  /** Structural check done? Install-grade approval requires true. */
  structuralCheckDone: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// 3. Roof-Plane
// ───────────────────────────────────────────────────────────────────────────

export interface RoofPlane {
  kind: 'roof-plane';
  id: string;
  buildingId: string;
  /** Azimuth in degrees (0=north, 180=south). Load-bearing for yield. */
  azimuthDeg: number;
  /** Tilt in degrees (0=flat, 90=vertical). */
  tiltDeg: number;
  /** Usable area in m². */
  areaM2: number;
  /** Available mounting area after subtracting edge/spacing margins. */
  usableAreaM2: number;
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Obstruction (shading/obstacle)
// ───────────────────────────────────────────────────────────────────────────

export type ObstructionType =
  | 'chimney'
  | 'dormer'
  | 'skylight'
  | 'tree'
  | 'neighbouring-building'
  | 'antenna'
  | 'vent';

export interface Obstruction {
  kind: 'obstruction';
  id: string;
  roofPlaneId: string;
  type: ObstructionType;
  /** Height above the roof plane in m — determines the shading angle. */
  heightM: number;
  /** Does this obstruction cause partial shading that affects string layout/MPPT? */
  causesPartialShading: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Module (PV module)
// ───────────────────────────────────────────────────────────────────────────

export interface PvModule {
  kind: 'module';
  id: string;
  manufacturer: string;
  model: string;
  /** Nominal power Wp. */
  wattPeak: number;
  /** Open-circuit voltage Uoc (V) @ STC — load-bearing for stringing. */
  vocStc: number;
  /** MPP voltage Umpp (V) @ STC. */
  vmpStc: number;
  /** Temperature coefficient Uoc in %/°C (negative) — Tmin extrapolation. */
  tempCoeffVocPctPerC: number;
}

// ───────────────────────────────────────────────────────────────────────────
// 6. Inverter
// ───────────────────────────────────────────────────────────────────────────

export interface Inverter {
  kind: 'inverter';
  id: string;
  manufacturer: string;
  model: string;
  /** AC nominal power W. */
  acNominalPowerW: number;
  /** Maximum DC input power W (determines the allowed module oversizing ratio). */
  maxDcPowerW: number;
  /** Maximum DC system voltage V — string Uoc(Tmin) must stay below it. */
  maxDcVoltageV: number;
  /** Number of independent MPP trackers — limits the number of strings with their own orientation. */
  mpptTrackers: number;
  /** MPPT voltage window [min,max] in V — string Umpp must fall inside it. */
  mpptVoltageWindowV: { min: number; max: number };
}

// ───────────────────────────────────────────────────────────────────────────
// 7. String (module string)
// ───────────────────────────────────────────────────────────────────────────

export interface PvString {
  kind: 'string';
  id: string;
  /** Which roof plane the string sits on (one orientation per string). */
  roofPlaneId: string;
  moduleId: string;
  /** Number of modules wired in series — determines the string voltage. */
  moduleCount: number;
  inverterId: string;
  /** Which MPP tracker the string is attached to (0-based, < inverter.mpptTrackers). */
  mpptInputIndex: number;
  /** Computed string voltage window at Tmin/Tmax (V). Load-bearing for the stringing gate. */
  voltageWindowV: { vocAtTmin: number; vmpAtTmax: number };
}

// ───────────────────────────────────────────────────────────────────────────
// 8. Battery (storage)
// ───────────────────────────────────────────────────────────────────────────

export type ChargeStrategy =
  | 'self-consumption'
  | 'peak-shaving'
  | 'time-of-use'
  | 'backup-priority';

export interface Battery {
  kind: 'battery';
  id: string;
  manufacturer: string;
  model: string;
  /** Gross capacity kWh. */
  nominalKwh: number;
  /** Usable capacity kWh (DoD-adjusted) — sizing-relevant. */
  usableKwh: number;
  /** Max. charge/discharge power kW. */
  maxChargePowerKw: number;
  maxDischargePowerKw: number;
  /** Charge/discharge strategy — an expert decision, not a default. */
  chargeStrategy: ChargeStrategy;
  /** AC- or DC-coupled — determines the inverter topology. */
  coupling: 'ac' | 'dc';
}

// ───────────────────────────────────────────────────────────────────────────
// 9. Consumption profile (load profile)
// ───────────────────────────────────────────────────────────────────────────

export interface ConsumptionProfile {
  kind: 'consumption-profile';
  id: string;
  leadId: string;
  /** Annual consumption kWh. */
  annualKwh: number;
  /** 24×12 or simplified — here: hourly-grid hint. */
  profileResolution: 'hourly' | 'monthly' | 'standard-load-profile';
  /** Heat pump/EV present — increases self-consumption sizing. */
  hasHeatPump: boolean;
  hasEvCharger: boolean;
}

// ───────────────────────────────────────────────────────────────────────────
// 10. Simulation run (yield simulation)
// ───────────────────────────────────────────────────────────────────────────

export interface SimulationRun {
  kind: 'simulation-run';
  id: string;
  buildingId: string;
  /** Which RoofPlanes + strings fed in (provenance). */
  inputStringIds: string[];
  /** Computed annual yield kWh. */
  annualYieldKwh: number;
  /** Self-consumption ratio 0..1 (with storage). */
  selfConsumptionRatio: number;
  /** Autarky degree 0..1. */
  autarkyRatio: number;
  /** Specific yield kWh/kWp — plausibility check. */
  specificYieldKwhPerKwp: number;
}

// ───────────────────────────────────────────────────────────────────────────
// 11. Quote
// ───────────────────────────────────────────────────────────────────────────

export interface Quote {
  kind: 'quote';
  id: string;
  leadId: string;
  /** Net total price EUR. */
  netTotalEur: number;
  /** Line items (BOM) — empty = surface only, not a real quote. */
  lineItemCount: number;
  /** Payback time in years — requires a simulation run as input. */
  paybackYears: number | null;
  /** Which grade may approve this quote (see Approval.grade). */
  requiresApprovalGrade: ApprovalGrade;
}

// ───────────────────────────────────────────────────────────────────────────
// 12. Approval (approval grade) — sales/proposal/install grade
// ───────────────────────────────────────────────────────────────────────────

/**
 * The three grades whose MISSING distinction is a blocker
 * ("no distinction between sales/proposal/install grade").
 *
 *   • sales    — rough sales assessment, no technical proof.
 *   • proposal — technical quote with simulation + stringing.
 *   • install  — install-ready: structural check done, string layout fixed,
 *                expert review mandatory.
 */
export type ApprovalGrade = 'sales' | 'proposal' | 'install';

export const APPROVAL_GRADES: readonly ApprovalGrade[] = [
  'sales',
  'proposal',
  'install',
] as const;

export interface Approval {
  kind: 'approval';
  id: string;
  quoteId: string;
  grade: ApprovalGrade;
  /** Was a human/expert involved? Install grade requires true (expert gate). */
  expertReviewed: boolean;
  /** Who reviewed (role) — empty for pure sales grade. */
  reviewerRole: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// 13. CRM-Sync-Event
// ───────────────────────────────────────────────────────────────────────────

export type CrmSyncDirection = 'inbound' | 'outbound';

export interface CrmSyncEvent {
  kind: 'crm-sync-event';
  id: string;
  leadId: string;
  direction: CrmSyncDirection;
  /** Which target CRM (e.g. 'hubspot', 'pipedrive', 'demo-pv-crm'). */
  targetSystem: string;
  /** Structured fields that get synced — empty = "note only" (blocker). */
  syncedFieldCount: number;
  /** Idempotency key — real integration, not a free-text note. */
  idempotencyKey: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Discriminated union + artifact container
// ───────────────────────────────────────────────────────────────────────────

export type DomainObject =
  | Lead
  | Building
  | RoofPlane
  | Obstruction
  | PvModule
  | Inverter
  | PvString
  | Battery
  | ConsumptionProfile
  | SimulationRun
  | Quote
  | Approval
  | CrmSyncEvent;

/**
 * An expert decision that the build artifact must have made.
 * Examples: 'stringing-validated', 'storage-sized', 'expert-reviewed',
 * 'tool-replacement-decided', 'install-grade-statics-checked'.
 *
 * Loosely typed as string so test cases can declare new decisions without
 * changing this module — the eval checks set membership.
 */
export type ExpertDecisionId = string;

/**
 * A build artifact = what a lane/run ultimately produces. The eval checks it
 * against the test cases. NO surface in the artifact — only a compiled domain
 * model + the decisions that were taken.
 */
export interface PvArtifact {
  /** All instantiated domain objects. */
  objects: DomainObject[];
  /** IDs of the expert decisions that were taken. */
  expertDecisions: ExpertDecisionId[];
}

// ───────────────────────────────────────────────────────────────────────────
// Deterministic domain-rule helpers (N6) — used by evaluate.ts
// ───────────────────────────────────────────────────────────────────────────

/** Returns all distinct object kinds present in the artifact. */
export function presentObjectKinds(artifact: PvArtifact): Set<DomainObjectKind> {
  return new Set(artifact.objects.map((o) => o.kind));
}

/**
 * Stringing domain rule (deterministic): a string is valid when
 *   (a) it is attached to an existing inverter/MPPT input,
 *   (b) its computed Uoc(Tmin) <= the inverter's maxDcVoltage,
 *   (c) its Umpp(Tmax) falls within the MPPT voltage window.
 * Returns a list of verbatim violations (empty = ok).
 */
export function stringingViolations(artifact: PvArtifact): string[] {
  const issues: string[] = [];
  const inverters = artifact.objects.filter(
    (o): o is Inverter => o.kind === 'inverter',
  );
  const strings = artifact.objects.filter(
    (o): o is PvString => o.kind === 'string',
  );

  for (const s of strings) {
    const inv = inverters.find((i) => i.id === s.inverterId);
    if (!inv) {
      issues.push(`String ${s.id} references unknown inverter ${s.inverterId}`);
      continue;
    }
    if (s.mpptInputIndex < 0 || s.mpptInputIndex >= inv.mpptTrackers) {
      issues.push(
        `String ${s.id}: mpptInputIndex ${s.mpptInputIndex} outside [0,${inv.mpptTrackers})`,
      );
    }
    if (s.voltageWindowV.vocAtTmin > inv.maxDcVoltageV) {
      issues.push(
        `String ${s.id}: Uoc(Tmin) ${s.voltageWindowV.vocAtTmin}V > inverter maxDc ${inv.maxDcVoltageV}V`,
      );
    }
    if (
      s.voltageWindowV.vmpAtTmax < inv.mpptVoltageWindowV.min ||
      s.voltageWindowV.vmpAtTmax > inv.mpptVoltageWindowV.max
    ) {
      issues.push(
        `String ${s.id}: Umpp(Tmax) ${s.voltageWindowV.vmpAtTmax}V outside MPPT window ` +
          `[${inv.mpptVoltageWindowV.min},${inv.mpptVoltageWindowV.max}]`,
      );
    }
  }
  return issues;
}
