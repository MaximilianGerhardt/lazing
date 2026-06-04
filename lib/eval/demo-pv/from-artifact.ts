/**
 * Demo PV (photovoltaic) regression eval · Build-artifact adapter
 * ════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `evaluate.ts` is deterministic + correct, but used to run ONLY against
 * hand-built `PvArtifact` fixtures (a closed self-test). The anti-MVP proof
 * ("A system that only builds a surface here, without compiling domain rules
 * and expert decisions, fails the gate.") is only DELIVERED once a REAL
 * lane/build output runs against the eval.
 *
 * This adapter is the missing bridge: it takes a generic, loosely typed
 * build/lane output object (`GenericBuildArtifact`) — as produced by a run
 * branch / a flow / a workstream — and maps it DEFENSIVELY onto the strict
 * `PvArtifact` structure (domain-model.ts).
 *
 * DESIGN PRINCIPLE: FAIL-SOFT, NOT FAIL-LOUD (N6 + anti-MVP)
 * ─────────────────────────────────────────────────────────
 * Missing/broken fields are NOT thrown — they become EMPTY domain-object
 * sets. This is intentional: an "only roof drawer" output that lacks
 * stringing/storage/inverter yields, after mapping, an artifact WITHOUT
 * `string`/`inverter`/`battery` objects — and exactly that trips the
 * `only-roof-drawer` / `no-electrical-model` blockers in `evaluate.ts`.
 * A robust adapter that "repaired" missing fields would SABOTAGE the
 * anti-MVP proof. Defensive here means: do not crash, but also do not
 * invent anything.
 *
 * SOURCE -> DOMAIN-OBJECT MAPPING (documented verbatim, N1)
 * ────────────────────────────────────────────────────────
 * Real lane/build sources feed into the adapter via `GenericBuildArtifact`.
 * The table below records which real source maps to which of the 13 domain
 * objects:
 *
 *   ┌─────────────────────────────┬──────────────────────────────────────────┐
 *   │ REAL SOURCE                  │ DOMAIN OBJECT(S)                          │
 *   ├─────────────────────────────┼──────────────────────────────────────────┤
 *   │ artifact.domainObjects[]     │ direct (already-typed DomainObjects —     │
 *   │   (when a lane already       │   e.g. expertise-compiler output). Taken  │
 *   │    emits the domain model)   │   1:1, validated by kind.                 │
 *   ├─────────────────────────────┼──────────────────────────────────────────┤
 *   │ artifact.surfacePayload      │ surface payload of a flow-graph/chat      │
 *   │   .roofPlanes[]              │   surface -> roof-plane (+ building, when │
 *   │   .building                  │   a roof-drawer surface was rendered).    │
 *   │                             │   The "only roof drawer" case.            │
 *   │   .strings[] / .inverters[] │   -> string / inverter / module / battery │
 *   │   .modules[] / .batteries[] │   (the ELECTRICAL model; if missing, the  │
 *   │                             │   artifact is MVP-suspect).               │
 *   │   .simulation / .quote      │   -> simulation-run / quote               │
 *   │   .approval                 │   -> approval                             │
 *   │   .crmSync                  │   -> crm-sync-event                       │
 *   │   .consumptionProfile       │   -> consumption-profile                  │
 *   │   .lead                     │   -> lead                                 │
 *   ├─────────────────────────────┼──────────────────────────────────────────┤
 *   │ artifact.files[]            │ run-branch files. Pure file output        │
 *   │   (path heuristic)          │   without a domain model = MVP indicator. │
 *   │                             │   We derive NO domain objects from raw    │
 *   │                             │   files (that would be "inventing") —     │
 *   │                             │   files serve only decision harvesting    │
 *   │                             │   via `kind` tags, see below.             │
 *   ├─────────────────────────────┼──────────────────────────────────────────┤
 *   │ artifact.decisions[]        │ workstream_decisions rows. Each decision  │
 *   │   .{id|decisionId|kind}     │   with a `decisionId`/`kind` flows into   │
 *   │                             │   the ExpertDecisionId set                │
 *   │                             │   (e.g. 'stringing-validated',            │
 *   │                             │   'yield-simulated', 'expert-reviewed').  │
 *   │                             │   -> artifact.expertDecisions[]           │
 *   ├─────────────────────────────┼──────────────────────────────────────────┤
 *   │ artifact.flowSteps[]        │ flow_steps rows. A completed flow step    │
 *   │   .{outputs|producedKind}   │   can carry domain objects in its         │
 *   │                             │   `outputs` (same shape as surfacePayload)│
 *   │                             │   AND mark a decision via `decisionId`.   │
 *   └─────────────────────────────┴──────────────────────────────────────────┘
 *
 * The order of source evaluation is additive: all found domain objects are
 * unioned (deduped by `kind`+`id`), all found decision IDs are unioned.
 */

import {
  DOMAIN_OBJECT_KINDS,
  type DomainObject,
  type DomainObjectKind,
  type ExpertDecisionId,
  type PvArtifact,
} from './domain-model';

// ───────────────────────────────────────────────────────────────────────────
// Generic build/lane output schema (loosely typed — real-world tolerant)
// ───────────────────────────────────────────────────────────────────────────

/**
 * A surface/flow output payload that CAN carry domain PV objects.
 * All fields optional — if one is missing, no domain object is created (fail-soft).
 *
 * The field names mirror the surface payload of a flow-graph/chat surface
 * (see the mapping table above). Values are `unknown[]` / `unknown` because the
 * real source is not type-checked; normalization is handled by this file.
 */
export interface PvSurfacePayload {
  lead?: unknown;
  building?: unknown;
  roofPlanes?: unknown[];
  obstructions?: unknown[];
  modules?: unknown[];
  strings?: unknown[];
  inverters?: unknown[];
  batteries?: unknown[];
  consumptionProfile?: unknown;
  simulation?: unknown;
  simulationRuns?: unknown[];
  quote?: unknown;
  quotes?: unknown[];
  approval?: unknown;
  approvals?: unknown[];
  crmSync?: unknown;
  crmSyncEvents?: unknown[];
}

/** A decision row (workstream_decisions / flow-step decision). */
export interface GenericDecision {
  /** Preferred: stable decision ID (e.g. 'stringing-validated'). */
  decisionId?: string;
  /** Alternative fields from which we derive the decision ID. */
  id?: string;
  kind?: string;
  rationale?: string;
}

/** A flow step (flow_steps) that can carry outputs + a decision. */
export interface GenericFlowStep {
  /** Domain output payload of the step (same shape as the surface payload). */
  outputs?: PvSurfacePayload;
  /** A decision ID marked directly on the step. */
  decisionId?: string;
  /** Status — only `done`/`completed` steps count as "produced". */
  status?: string;
}

/** A run-branch file (purely heuristic, yields NO domain objects). */
export interface GenericFile {
  path?: string;
  kind?: string;
}

/**
 * The generic build/lane output object. All fields optional — an empty object
 * maps to an empty `PvArtifact` (which then correctly fails in the eval via
 * the `missing-object` hits).
 */
export interface GenericBuildArtifact {
  /** Already-typed domain objects (when a lane emits the domain model). */
  domainObjects?: unknown[];
  /** Surface/chat payload with potential domain objects. */
  surfacePayload?: PvSurfacePayload;
  /** flow_steps rows. */
  flowSteps?: GenericFlowStep[];
  /** workstream_decisions rows. Also accepts plain decision-ID strings. */
  decisions?: Array<GenericDecision | string>;
  /** run-branch files (heuristic). */
  files?: GenericFile[];
}

// ───────────────────────────────────────────────────────────────────────────
// Defensive normalizers
// ───────────────────────────────────────────────────────────────────────────

const KIND_SET = new Set<string>(DOMAIN_OBJECT_KINDS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Takes a raw value and accepts it as a DomainObject ONLY if it is a record
 * with a `kind` from the 13-kind canon AND a string `id`.
 * Everything else -> null (discarded, NOT repaired).
 */
function coerceDomainObject(raw: unknown): DomainObject | null {
  if (!isRecord(raw)) return null;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) return null;
  if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
  // We trust the lane that its emitted object carries the domain fields — the
  // eval checks set membership of the KINDS, while the deeper domain rules
  // (stringing voltage window) are checked by the detectors in evaluate.ts
  // against the present fields. If a field is missing, the rule trips there.
  return raw as unknown as DomainObject;
}

/**
 * Stamps a `kind` onto a raw record (if missing) and then coerces it. This
 * lets surface payloads supply their objects WITHOUT an explicit `kind` field
 * — we know from the payload slot which kind is meant.
 */
function coerceWithKind(raw: unknown, kind: DomainObjectKind): DomainObject | null {
  if (!isRecord(raw)) return null;
  const stamped = 'kind' in raw && raw.kind === kind ? raw : { ...raw, kind };
  return coerceDomainObject(stamped);
}

/** Maps a surface payload to domain objects (fail-soft per slot). */
function objectsFromSurface(payload: PvSurfacePayload | undefined): DomainObject[] {
  if (!isRecord(payload)) return [];
  const out: DomainObject[] = [];

  const single: Array<[unknown, DomainObjectKind]> = [
    [payload.lead, 'lead'],
    [payload.building, 'building'],
    [payload.consumptionProfile, 'consumption-profile'],
    [payload.simulation, 'simulation-run'],
    [payload.quote, 'quote'],
    [payload.approval, 'approval'],
    [payload.crmSync, 'crm-sync-event'],
  ];
  for (const [raw, kind] of single) {
    const obj = coerceWithKind(raw, kind);
    if (obj) out.push(obj);
  }

  const lists: Array<[unknown, DomainObjectKind]> = [
    [payload.roofPlanes, 'roof-plane'],
    [payload.obstructions, 'obstruction'],
    [payload.modules, 'module'],
    [payload.strings, 'string'],
    [payload.inverters, 'inverter'],
    [payload.batteries, 'battery'],
    [payload.simulationRuns, 'simulation-run'],
    [payload.quotes, 'quote'],
    [payload.approvals, 'approval'],
    [payload.crmSyncEvents, 'crm-sync-event'],
  ];
  for (const [rawList, kind] of lists) {
    for (const raw of asArray(rawList)) {
      const obj = coerceWithKind(raw, kind);
      if (obj) out.push(obj);
    }
  }

  return out;
}

/** Derives a decision ID from a raw decision row (or null). */
function decisionIdOf(raw: unknown): ExpertDecisionId | null {
  if (typeof raw === 'string') return raw.length > 0 ? raw : null;
  if (!isRecord(raw)) return null;
  const candidates = [raw.decisionId, raw.id, raw.kind];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/**
 * Deduplicates domain objects by `kind`+`id` (stable order: first occurrence
 * wins). Prevents the same object that appears in multiple sources from
 * counting twice.
 */
function dedupeObjects(objects: DomainObject[]): DomainObject[] {
  const seen = new Set<string>();
  const out: DomainObject[] = [];
  for (const o of objects) {
    const key = `${o.kind}::${o.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Main adapter
// ───────────────────────────────────────────────────────────────────────────

/**
 * Maps a generic build/lane output onto a strict `PvArtifact`.
 *
 * DETERMINISTIC (N6): pure function, no I/O, no randomness, idempotent.
 * FAIL-SOFT: NEVER throws; missing/broken fields -> empty domain sets.
 *
 * @param artifact generic output (see `GenericBuildArtifact`). `null`/
 *                 `undefined`/non-object -> empty PvArtifact.
 */
export function mapArtifactToPvArtifact(
  artifact: GenericBuildArtifact | null | undefined,
): PvArtifact {
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    return { objects: [], expertDecisions: [] };
  }

  const objects: DomainObject[] = [];

  // (1) Already-typed domain objects (the lane emitted the domain model).
  for (const raw of asArray(artifact.domainObjects)) {
    const obj = coerceDomainObject(raw);
    if (obj) objects.push(obj);
  }

  // (2) Surface payload.
  objects.push(...objectsFromSurface(artifact.surfacePayload));

  // (3) Flow steps: only completed steps contribute produced objects.
  const decisionIds: ExpertDecisionId[] = [];
  for (const step of asArray(artifact.flowSteps) as GenericFlowStep[]) {
    if (typeof step !== 'object' || step === null) continue;
    const done =
      step.status === undefined ||
      step.status === 'done' ||
      step.status === 'completed';
    if (done) {
      objects.push(...objectsFromSurface(step.outputs));
    }
    const did = decisionIdOf(step.decisionId);
    if (did) decisionIds.push(did);
  }

  // (4) Decisions (workstream_decisions / flow-step decisions).
  for (const raw of asArray(artifact.decisions)) {
    const did = decisionIdOf(raw);
    if (did) decisionIds.push(did);
  }

  // (5) files[] INTENTIONALLY contribute no domain objects (see mapping doc:
  //     raw files without a domain model are the MVP indicator, not the
  //     domain model itself). They could be used for provenance in the future.

  return {
    objects: dedupeObjects(objects),
    // Decision IDs deduped, order stable.
    expertDecisions: Array.from(new Set(decisionIds)),
  };
}
