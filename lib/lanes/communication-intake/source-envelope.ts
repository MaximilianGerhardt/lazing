/**
 * Lane A — Communication Intake · Source-Envelope-Builder
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29.
 *
 * Master-Briefing §7.3 Schritt 2 (verbatim, N1):
 *   „Quelle, Sprecher, Zeit, Projekt und Sensitivitaet erfassen."
 *
 * Diese Datei ist eine pure Funktion: gleiche Inputs → gleiches Envelope
 * inkl. identischem contentHash (N10). KEIN DB-Read, keine Netz-I/O.
 *
 * Substrat-Disziplin:
 *   - N1:  rawContent VERBATIM. Niemals slice/substring/Paraphrase.
 *   - N6:  deterministische Validatoren VOR allem.
 *   - N9:  projectScope = workspaceId (ManifestCoord-Scope).
 *   - N10: contentHash = sha256 über kanonisches JSON eines fix definierten
 *          Teilsets der envelope-Identität (externalId + dataSource +
 *          rawContent + receivedAt + projectScope). Reihenfolge der Keys ist
 *          alphabetisch erzwungen, damit der Hash über Implementierungen
 *          stabil ist.
 */

import { createHash } from "node:crypto";

import {
  DATA_SOURCES,
  INTAKE_SENSITIVITIES,
  RAW_CONTENT_TYPES,
  type DataSource,
  type IntakeSensitivity,
  type RawContentType,
  type SourceEnvelope,
} from "./types";

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

const DATA_SOURCE_SET = new Set<DataSource>(DATA_SOURCES);
const SENSITIVITY_SET = new Set<IntakeSensitivity>(INTAKE_SENSITIVITIES);
const RAW_CONTENT_TYPE_SET = new Set<RawContentType>(RAW_CONTENT_TYPES);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** N10: sha256 hex über kanonisches JSON. Reihenfolge der Keys deterministisch. */
function sha256hex(payload: Record<string, unknown>): string {
  const keys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of keys) canonical[k] = payload[k];
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ───────────────────────────────────────────────────────────────────────────
// BuildSourceEnvelopeInput
// ───────────────────────────────────────────────────────────────────────────

export interface BuildSourceEnvelopeInput {
  readonly externalId: string;
  readonly dataSource: DataSource;
  readonly speakerExternalId?: string;
  readonly speakerLocalId?: string;
  readonly receivedAt: number;
  readonly sensitivity: IntakeSensitivity;
  readonly projectScope: string;
  readonly rawContent: string;
  readonly rawContentType: RawContentType;
  readonly parentEnvelopeId?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// buildSourceEnvelope — Pure, deterministisch
// ───────────────────────────────────────────────────────────────────────────

/**
 * Baut einen `SourceEnvelope` aus dem rohen Input. Wirft bei ungültigem
 * Vokabular ODER fehlendem Pflicht-Feld (fail-fast in der Konstruktion;
 * die laufende Pipeline ist dagegen fail-soft).
 *
 * Reine Funktion — gleicher Input ⇒ gleiches Envelope. Insbesondere:
 *   - rawContent wird VERBATIM übernommen (kein trim/slice).
 *   - contentHash wird ÜBER `externalId + dataSource + rawContent +
 *     receivedAt + projectScope` berechnet — bewusst NICHT über
 *     speakerExternalId/speakerLocalId, damit eine spätere Speaker-Resolution
 *     den Hash nicht invalidiert (sie ist Annotation, nicht Identität).
 */
export function buildSourceEnvelope(
  input: BuildSourceEnvelopeInput,
): SourceEnvelope {
  if (!isNonEmptyString(input.externalId)) {
    throw new Error("buildSourceEnvelope: externalId required");
  }
  if (!DATA_SOURCE_SET.has(input.dataSource)) {
    throw new Error(
      `buildSourceEnvelope: invalid dataSource '${String(input.dataSource)}'`,
    );
  }
  if (!isFiniteNonNegativeNumber(input.receivedAt)) {
    throw new Error(
      "buildSourceEnvelope: receivedAt must be a non-negative finite number (ms epoch)",
    );
  }
  if (!SENSITIVITY_SET.has(input.sensitivity)) {
    throw new Error(
      `buildSourceEnvelope: invalid sensitivity '${String(input.sensitivity)}'`,
    );
  }
  if (!isNonEmptyString(input.projectScope)) {
    throw new Error(
      "buildSourceEnvelope: projectScope (workspaceId, N9) required",
    );
  }
  if (typeof input.rawContent !== "string") {
    throw new Error("buildSourceEnvelope: rawContent must be a string (N1 verbatim)");
  }
  if (!RAW_CONTENT_TYPE_SET.has(input.rawContentType)) {
    throw new Error(
      `buildSourceEnvelope: invalid rawContentType '${String(input.rawContentType)}'`,
    );
  }
  if (
    input.speakerExternalId !== undefined &&
    !isNonEmptyString(input.speakerExternalId)
  ) {
    throw new Error(
      "buildSourceEnvelope: speakerExternalId, if set, must be non-empty",
    );
  }
  if (
    input.speakerLocalId !== undefined &&
    !isNonEmptyString(input.speakerLocalId)
  ) {
    throw new Error(
      "buildSourceEnvelope: speakerLocalId, if set, must be non-empty",
    );
  }
  if (
    input.parentEnvelopeId !== undefined &&
    !isNonEmptyString(input.parentEnvelopeId)
  ) {
    throw new Error(
      "buildSourceEnvelope: parentEnvelopeId, if set, must be non-empty",
    );
  }

  const contentHash = sha256hex({
    external_id: input.externalId,
    data_source: input.dataSource,
    raw_content: input.rawContent,
    received_at: input.receivedAt,
    project_scope: input.projectScope,
  });

  const envelope: SourceEnvelope = {
    externalId: input.externalId,
    dataSource: input.dataSource,
    ...(input.speakerExternalId !== undefined
      ? { speakerExternalId: input.speakerExternalId }
      : {}),
    ...(input.speakerLocalId !== undefined
      ? { speakerLocalId: input.speakerLocalId }
      : {}),
    receivedAt: input.receivedAt,
    sensitivity: input.sensitivity,
    projectScope: input.projectScope,
    rawContent: input.rawContent, // N1: verbatim
    rawContentType: input.rawContentType,
    ...(input.parentEnvelopeId !== undefined
      ? { parentEnvelopeId: input.parentEnvelopeId }
      : {}),
    contentHash,
  };

  return envelope;
}

/**
 * Re-berechnet den contentHash aus einem bestehenden Envelope-Like Objekt.
 * Nützlich für Tests + Idempotenz-Checks.
 */
export function computeEnvelopeContentHash(args: {
  externalId: string;
  dataSource: DataSource;
  rawContent: string;
  receivedAt: number;
  projectScope: string;
}): string {
  return sha256hex({
    external_id: args.externalId,
    data_source: args.dataSource,
    raw_content: args.rawContent,
    received_at: args.receivedAt,
    project_scope: args.projectScope,
  });
}
