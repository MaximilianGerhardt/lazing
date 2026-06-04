/**
 * Lane A — Communication Intake · Intake-Writer
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29 · KERN-Remediation (IST/SOLL: Schema 0119 gebaut,
 * aber KEIN Writer — diese Datei schliesst die Luecke).
 *
 * Master-Briefing §7.3 Schritt 1+2 (verbatim, N1):
 *   „1. Verbatim speichern. 2. Quelle, Sprecher, Zeit, Projekt und
 *    Sensitivitaet erfassen."
 * Master-Briefing §7.2 (verbatim, N1):
 *   „Imported context must not auto-run."
 *
 * Diese Datei ist der EINZIGE Schreiber in intake_events (0119). Sie nimmt
 * einen bereits gebauten `SourceEnvelope` (source-envelope.ts — die pure,
 * deterministische Identitaets-/Hash-Schicht) und persistiert ihn als EINE
 * intake_events-Row im FSM-Startzustand `received` (→ in der Schema-Sprache:
 * `staged`; siehe FSM-Mapping unten).
 *
 * Reines DB-Modul: nimmt ein rohes better-sqlite3-Handle (analog
 * lib/reasoning/beliefs-repo.ts + mirror-to-beliefs.ts) — kein getDb()-
 * Singleton, in-memory testbar. KEIN LLM, keine Netz-I/O.
 *
 * ── FSM (No-auto-run, §7.2/§7.3) ─────────────────────────────────────────
 *
 * Die Owner-Direktive spricht von der Pipeline received→normalized→
 * ready-for-compile. Das 0119-Schema kennt CHECK-erzwungene FSM-States
 * `staged | classified | ready-for-compile | blocked`. Wir bilden die
 * konzeptionelle Pipeline DETERMINISTISCH auf die Schema-States ab (reine
 * Funktion `nextFsmState`, kein DB):
 *
 *   received      ──→ staged              (Schritt 1+2 persistiert, verbatim)
 *   normalized    ──→ classified          (Schritt 3: nudge_class gesetzt)
 *   ready-for-compile ──→ ready-for-compile (Schritt 4: Lane B darf abholen)
 *   blocked       ──→ blocked             (Consent/Gate denied)
 *
 * `insertIntakeEvent` schreibt IMMER mit dem Start-State `staged` (= received) —
 * NICHTS laeuft danach automatisch weiter (§7.2). Der Fortschritt
 * staged→classified→ready-for-compile geschieht via UPDATE (der 0119-Trigger
 * erlaubt genau fsm_state/nudge_class/speaker_local_id/updated_at) — und wird
 * von der spaeteren Pipeline/Owner-Action getrieben, nicht hier.
 *
 * Disziplin:
 *   - N1:  raw_content VERBATIM aus envelope.rawContent (kein .slice/.substring).
 *   - N6:  deterministischer FSM-Mapper + Vokabular-Validierung VOR dem Insert.
 *   - N8:  append-only-konform — wir respektieren die 0119-Trigger (kein DELETE,
 *          keine Kern-Mutation). Re-Insert desselben content_hash wird
 *          dedupliziert (Idempotenz statt Constraint-Crash).
 *   - N9:  workspace_id = envelope.projectScope (ManifestCoord-Scope).
 *   - N10: content_hash wird VERBATIM aus dem envelope uebernommen (die pure
 *          Hash-Schicht in source-envelope.ts ist die Wahrheit; wir erfinden
 *          keinen zweiten Hash-Algorithmus).
 */

import {
  classify,
} from "./nudge-classifier";
import type {
  ClassificationStatus,
  IntakeEvent,
  NudgeClass,
  SourceEnvelope,
} from "./types";
import { ulid } from "@/lib/ulid";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// FSM — konzeptionelle Pipeline ↔ Schema-States (deterministisch, N6)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Konzeptionelle Pipeline-Phasen aus der Owner-Direktive (received→normalized→
 * ready-for-compile). Diese sind die SPRACHE der Pipeline; das Schema speichert
 * die abgebildeten Schema-States (ClassificationStatus).
 */
export type IntakeFsmPhase =
  | "received"
  | "normalized"
  | "ready-for-compile"
  | "blocked";

export const INTAKE_FSM_PHASES: readonly IntakeFsmPhase[] = [
  "received",
  "normalized",
  "ready-for-compile",
  "blocked",
] as const;

/**
 * Reine Funktion: bildet eine konzeptionelle Pipeline-Phase auf den
 * Schema-FSM-State (ClassificationStatus) ab. Deterministisch (N6), kein DB.
 */
export function phaseToSchemaState(phase: IntakeFsmPhase): ClassificationStatus {
  switch (phase) {
    case "received":
      return "staged";
    case "normalized":
      return "classified";
    case "ready-for-compile":
      return "ready-for-compile";
    case "blocked":
      return "blocked";
    default: {
      // Exhaustiveness-Guard (N6) — unbekannte Phase ist ein Programmierfehler.
      const _never: never = phase;
      throw new Error(`phaseToSchemaState: unknown phase '${String(_never)}'`);
    }
  }
}

/**
 * Reine Funktion: legaler FSM-Uebergang? Die No-auto-run-Pipeline ist STRICT
 * vorwaerts (§7.2 — nichts springt zurueck oder ueberspringt):
 *
 *   received  → normalized | blocked
 *   normalized → ready-for-compile | blocked
 *   ready-for-compile → (terminal; Lane B holt ab — kein auto-run weiter)
 *   blocked   → (terminal; Owner muss neu staging)
 *
 * Idempotente Selbst-Uebergaenge (X→X) sind ERLAUBT (no-op), damit ein
 * wiederholter Pipeline-Lauf nicht crasht.
 */
export function isLegalFsmTransition(
  from: IntakeFsmPhase,
  to: IntakeFsmPhase,
): boolean {
  if (from === to) return true; // idempotenter no-op
  switch (from) {
    case "received":
      return to === "normalized" || to === "blocked";
    case "normalized":
      return to === "ready-for-compile" || to === "blocked";
    case "ready-for-compile":
      return false; // terminal — kein auto-run weiter (§7.2)
    case "blocked":
      return false; // terminal
    default:
      return false;
  }
}

/**
 * Reine Funktion: naechste Phase bei normalem Vorwaerts-Fortschritt (ohne
 * block). Wirft NICHT — gibt die unveraenderte Phase zurueck, wenn terminal.
 */
export function nextFsmPhase(from: IntakeFsmPhase): IntakeFsmPhase {
  switch (from) {
    case "received":
      return "normalized";
    case "normalized":
      return "ready-for-compile";
    default:
      return from; // terminal (ready-for-compile | blocked) — kein Fortschritt
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Row-Mapper
// ───────────────────────────────────────────────────────────────────────────

function mapIntakeRow(r: Record<string, unknown>): IntakeEvent {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    externalId: (r.external_id as string | null) ?? null,
    dataSource: r.source_kind as IntakeEvent["dataSource"],
    speakerExternalId: (r.speaker_external_id as string | null) ?? null,
    speakerLocalId: (r.speaker_local_id as string | null) ?? null,
    receivedAt: Number(r.received_at),
    sensitivity: r.sensitivity as IntakeEvent["sensitivity"],
    rawContent: String(r.raw_content), // N1 verbatim
    rawContentType: r.raw_content_type as IntakeEvent["rawContentType"],
    parentEnvelopeId: (r.parent_envelope_id as string | null) ?? null,
    nudgeClass: (r.nudge_class as NudgeClass | null) ?? null,
    classificationStatus: r.fsm_state as ClassificationStatus,
    contentHash: String(r.content_hash),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// insertIntakeEvent — der Lane-A-Writer
// ───────────────────────────────────────────────────────────────────────────

export interface InsertIntakeEventOpts {
  /** Override fuer Test-Reproduktion (created_at/updated_at). Default Date.now(). */
  readonly nowMs?: number;
  /**
   * Bei Schritt 1 (received) ist nudge_class noch NULL (Klassifikation ist
   * Schritt 3). Wenn der Caller die Klassifikation gleich mitschreiben will
   * (z.B. eine API-Route, die staged+classified in einem Rutsch macht), setzt
   * er `classifyNow: true` — dann wird der deterministische Nudge-Classifier
   * (nudge-classifier.ts) angewendet UND der FSM auf `classified` (normalized)
   * gehoben. Default false → reines received/staged.
   */
  readonly classifyNow?: boolean;
}

export interface InsertIntakeEventResult {
  /** Die angelegte (oder bei Idempotenz: bereits vorhandene) intake_events-Row. */
  readonly event: IntakeEvent;
  /** true, wenn ein Row mit demselben content_hash im Workspace bereits existierte. */
  readonly deduplicated: boolean;
}

/**
 * Persistiert einen `SourceEnvelope` als EINE intake_events-Row (0119).
 *
 * - FSM-Start: `staged` (= received). KEIN auto-run weiter (§7.2). Wenn
 *   `opts.classifyNow` gesetzt ist, wird zusaetzlich der deterministische
 *   Nudge-Classifier angewendet und der State auf `classified` (normalized)
 *   gehoben — beides in einem Insert, immer noch ohne Lane-B-Spawn.
 * - Idempotenz (N10): existiert im selben Workspace bereits eine Row mit dem
 *   envelope.contentHash, wird NICHT erneut inserted — die vorhandene Row wird
 *   zurueckgegeben (deduplicated=true). Das respektiert den append-only-Trigger
 *   (kein UPDATE/DELETE noetig) und macht Re-Importe derselben Nachricht sicher.
 *
 * Wirft (fail-fast in der Konstruktion) bei:
 *   - fehlendem/leerem rawContent (N1 — wir staging NICHTS Leeres),
 *   - fehlendem/leerem projectScope (N9),
 *   - fehlendem contentHash (N10 — der envelope muss die Hash-Schicht durchlaufen
 *     haben; wir erfinden hier keinen Hash).
 *
 * @param raw       rohes better-sqlite3-Handle
 * @param envelope  ein via buildSourceEnvelope() gebauter SourceEnvelope
 * @param opts      nowMs (Test) + classifyNow (received→classified in einem Schritt)
 */
export function insertIntakeEvent(
  raw: RawDb,
  envelope: SourceEnvelope,
  opts: InsertIntakeEventOpts = {},
): InsertIntakeEventResult {
  // N6: deterministische Validierung VOR dem Insert.
  if (!envelope || typeof envelope !== "object") {
    throw new Error("insertIntakeEvent: envelope required");
  }
  if (typeof envelope.rawContent !== "string" || envelope.rawContent.length === 0) {
    throw new Error(
      "insertIntakeEvent: envelope.rawContent must be a non-empty string (N1 verbatim)",
    );
  }
  if (
    typeof envelope.projectScope !== "string" ||
    envelope.projectScope.length === 0
  ) {
    throw new Error(
      "insertIntakeEvent: envelope.projectScope (workspaceId, N9) required",
    );
  }
  if (
    typeof envelope.contentHash !== "string" ||
    envelope.contentHash.length === 0
  ) {
    throw new Error(
      "insertIntakeEvent: envelope.contentHash required (N10 — build it via buildSourceEnvelope)",
    );
  }

  const workspaceId = envelope.projectScope;

  // Idempotenz (N10): gibt es im Workspace bereits eine Row mit diesem Hash?
  const existing = raw
    .prepare(
      `SELECT id, workspace_id, external_id, source_kind, speaker_external_id,
              speaker_local_id, received_at, sensitivity, raw_content,
              raw_content_type, parent_envelope_id, nudge_class, fsm_state,
              content_hash, created_at, updated_at
         FROM intake_events
        WHERE content_hash = ? AND workspace_id = ?
        LIMIT 1`,
    )
    .get(envelope.contentHash, workspaceId) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    return { event: mapIntakeRow(existing), deduplicated: true };
  }

  // FSM-Start: received → staged. Optional gleich klassifizieren (normalized).
  let phase: IntakeFsmPhase = "received";
  let nudgeClass: NudgeClass | null = null;
  if (opts.classifyNow === true) {
    // Deterministischer Nudge-Classifier (N6, kein LLM). Fail-soft → 'noise'.
    nudgeClass = classify(envelope);
    phase = "normalized";
  }
  const fsmState = phaseToSchemaState(phase);

  const id = `INE-${ulid()}`;
  const ts = Number.isFinite(opts.nowMs) ? (opts.nowMs as number) : Date.now();

  const row: IntakeEvent = {
    id,
    workspaceId,
    externalId: envelope.externalId ?? null,
    dataSource: envelope.dataSource,
    speakerExternalId: envelope.speakerExternalId ?? null,
    speakerLocalId: envelope.speakerLocalId ?? null,
    receivedAt: envelope.receivedAt,
    sensitivity: envelope.sensitivity,
    rawContent: envelope.rawContent, // N1 verbatim
    rawContentType: envelope.rawContentType,
    parentEnvelopeId: envelope.parentEnvelopeId ?? null,
    nudgeClass,
    classificationStatus: fsmState,
    contentHash: envelope.contentHash, // N10 verbatim aus der Hash-Schicht
    createdAt: ts,
    updatedAt: ts,
  };

  raw
    .prepare(
      `INSERT INTO intake_events
         (id, workspace_id, external_id, source_kind, speaker_external_id,
          speaker_local_id, received_at, sensitivity, raw_content,
          raw_content_type, parent_envelope_id, nudge_class, fsm_state,
          content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.workspaceId,
      row.externalId,
      row.dataSource,
      row.speakerExternalId,
      row.speakerLocalId,
      row.receivedAt,
      row.sensitivity,
      row.rawContent,
      row.rawContentType,
      row.parentEnvelopeId,
      row.nudgeClass,
      row.classificationStatus,
      row.contentHash,
      row.createdAt,
      row.updatedAt,
    );

  return { event: row, deduplicated: false };
}

// ───────────────────────────────────────────────────────────────────────────
// advanceIntakeFsm — FSM-Fortschritt via erlaubtem UPDATE (N8-konform)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Treibt eine bestehende intake_events-Row in der FSM EINEN legalen Schritt
 * vorwaerts (staged→classified→ready-for-compile) bzw. nach `blocked`. Nutzt
 * NUR das vom 0119-Trigger erlaubte UPDATE (fsm_state/nudge_class/updated_at).
 *
 * Wirft, wenn der Uebergang illegal ist (isLegalFsmTransition=false) — die
 * No-auto-run-FSM (§7.2) ist strikt: kein Sprung, kein Rueckschritt.
 *
 * KEIN auto-run nach ready-for-compile: ready-for-compile ist terminal in
 * dieser FSM; das Abholen durch Lane B (compileKnowledgeForms) ist eine
 * SEPARATE, human-/owner-getriggerte Aktion (nicht hier).
 *
 * @returns die aktualisierte Row, oder null, wenn die id im Workspace fehlt.
 */
export function advanceIntakeFsm(
  raw: RawDb,
  args: {
    id: string;
    workspaceId: string;
    to: IntakeFsmPhase;
    nudgeClass?: NudgeClass | null;
    nowMs?: number;
  },
): IntakeEvent | null {
  if (typeof args.id !== "string" || args.id.length === 0) {
    throw new Error("advanceIntakeFsm: id required");
  }
  if (typeof args.workspaceId !== "string" || args.workspaceId.length === 0) {
    throw new Error("advanceIntakeFsm: workspaceId required");
  }

  const current = raw
    .prepare(
      `SELECT id, workspace_id, external_id, source_kind, speaker_external_id,
              speaker_local_id, received_at, sensitivity, raw_content,
              raw_content_type, parent_envelope_id, nudge_class, fsm_state,
              content_hash, created_at, updated_at
         FROM intake_events
        WHERE id = ? AND workspace_id = ?
        LIMIT 1`,
    )
    .get(args.id, args.workspaceId) as Record<string, unknown> | undefined;
  if (!current) return null;

  const currentEvent = mapIntakeRow(current);
  const fromPhase = schemaStateToPhase(currentEvent.classificationStatus);

  if (!isLegalFsmTransition(fromPhase, args.to)) {
    throw new Error(
      `advanceIntakeFsm: illegal transition '${fromPhase}' → '${args.to}' (§7.2 no-auto-run FSM is strict-forward)`,
    );
  }

  if (fromPhase === args.to && args.nudgeClass === undefined) {
    return currentEvent; // idempotenter no-op
  }

  const toState = phaseToSchemaState(args.to);
  const nextNudge =
    args.nudgeClass !== undefined ? args.nudgeClass : currentEvent.nudgeClass;
  const ts = Number.isFinite(args.nowMs) ? (args.nowMs as number) : Date.now();

  raw
    .prepare(
      `UPDATE intake_events
          SET fsm_state = ?, nudge_class = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
    )
    .run(toState, nextNudge, ts, args.id, args.workspaceId);

  return {
    ...currentEvent,
    classificationStatus: toState,
    nudgeClass: nextNudge,
    updatedAt: ts,
  };
}

/** Reine Inverse zu phaseToSchemaState (deterministisch, N6). */
export function schemaStateToPhase(state: ClassificationStatus): IntakeFsmPhase {
  switch (state) {
    case "staged":
      return "received";
    case "classified":
      return "normalized";
    case "ready-for-compile":
      return "ready-for-compile";
    case "blocked":
      return "blocked";
    default: {
      const _never: never = state;
      throw new Error(`schemaStateToPhase: unknown state '${String(_never)}'`);
    }
  }
}
