/**
 * Lane A — Communication Intake · Types
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29.
 *
 * Master-Briefing §25.1 Lane A (verbatim, N1):
 *   „Communication Intake. Ziel: Klaeren, wie WhatsApp/Telegram/Voice/
 *    Meeting-Kommunikation ohne Copy-Paste in laz.ing einfliessen kann.
 *    Artefakte: Source Envelope · Consent-Modell · Context Intake Surface ·
 *    No-auto-run-State-Machine · Nudge-Klassen."
 *
 * Master-Briefing §7.2 (verbatim, N1):
 *   „Imported context must not auto-run."
 *
 * Master-Briefing §7.3 Pipeline (verbatim, N1):
 *   „1. Verbatim speichern. 2. Quelle, Sprecher, Zeit, Projekt und
 *    Sensitivitaet erfassen. 3. Klassifizieren. 4. Relevante Begriffe,
 *    Entscheidungen, Fragen und Konflikte extrahieren. 5. In Decision
 *    Brief, Why Bank, Glossary oder Open Questions ueberfuehren. 6. Erst
 *    nach Freigabe in Planung oder Build uebergeben."
 *
 * Diese Datei deklariert das Vokabular des Source-Envelope, die Nudge-
 * Klassifikation, die kandidaten-Extraktion und die Pipeline-Ergebnisse.
 *
 * Reines Type-Modul — keine Runtime-Imports, keine Side-Effects.
 *
 * SUBSTRAT (N4): Tabelle intake_events (Migration 0119). KEIN Eingriff in
 * workstream_decisions, workspace_beliefs oder events. Lane A schreibt in
 * intake_events; Lane B (Expertise-Compiler) liest später daraus.
 */

// ───────────────────────────────────────────────────────────────────────────
// DataSource — exakt das Vokabular aus lib/governance/consent.ts (kein Drift)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Datenquellen, die Lane A konsumiert. ABSICHTLICH 1:1 deckungsgleich mit
 * `ConsentLevel.DataSource` aus lib/governance/consent.ts — Lane A delegiert
 * Consent-Checks an Lane G und darf nichts erlauben, was Lane G nicht kennt.
 */
export type DataSource =
  | "whatsapp"
  | "telegram"
  | "voice"
  | "meeting"
  | "email"
  | "browser-shadow"
  | "screen-capture"
  | "keystroke-capture"
  | "workspace-derive";

export const DATA_SOURCES: readonly DataSource[] = [
  "whatsapp",
  "telegram",
  "voice",
  "meeting",
  "email",
  "browser-shadow",
  "screen-capture",
  "keystroke-capture",
  "workspace-derive",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Sensitivity — vier-Stufen-Skala, identisch zu consent_grants.level-Geist
// ───────────────────────────────────────────────────────────────────────────

export type IntakeSensitivity =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

export const INTAKE_SENSITIVITIES: readonly IntakeSensitivity[] = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// RawContentType — wie der Rohinhalt vorliegt
// ───────────────────────────────────────────────────────────────────────────

export type RawContentType =
  | "text"
  | "audio"
  | "image"
  | "video"
  | "pdf"
  | "html";

export const RAW_CONTENT_TYPES: readonly RawContentType[] = [
  "text",
  "audio",
  "image",
  "video",
  "pdf",
  "html",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// SourceEnvelope — §7.3 Schritt 1+2 (verbatim speichern + Quelle/Sprecher/
// Zeit/Projekt/Sensitivitaet)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Das Envelope, das jede eingehende Kommunikation in laz.ing trägt.
 *
 * `rawContent` ist VERBATIM (N1) — keine Kürzung, keine Paraphrase. Das
 * intake_events-Schema (Migration 0119) hat KEINE TEXT(N)-Längen.
 *
 * `contentHash` (N10) = sha256 über kanonisches JSON der envelope-Identität
 * (externalId + dataSource + rawContent + receivedAt). Damit ist die
 * Idempotenz herstellbar: derselbe Input → derselbe Hash → derselbe Insert
 * (oder ein vorhandener Row, dedupliziert).
 */
export interface SourceEnvelope {
  /** ID vom externen System (whatsapp message id, telegram update id, …). */
  readonly externalId: string;
  readonly dataSource: DataSource;
  /** Wer hat es gesagt — externe ID des Sprechers/Senders. */
  readonly speakerExternalId?: string;
  /** Mapped auf den lokalen User/Contact (sobald die Auflösung greift). */
  readonly speakerLocalId?: string;
  /** ms-Epoch. Wann ist die Quelle entstanden (nicht: wann wir sie sehen). */
  readonly receivedAt: number;
  readonly sensitivity: IntakeSensitivity;
  /** workspaceId — N9 ManifestCoord-Scope. */
  readonly projectScope: string;
  /** VERBATIM Inhalt (N1). KEIN slice. */
  readonly rawContent: string;
  readonly rawContentType: RawContentType;
  /** Reply/Forward-Kette — Soft-FK auf eine andere envelope.id im selben Workspace. */
  readonly parentEnvelopeId?: string;
  /** sha256 über kanonisches JSON (N10). */
  readonly contentHash: string;
}

// ───────────────────────────────────────────────────────────────────────────
// NudgeClass — §25.1 „Nudge-Klassen"
// ───────────────────────────────────────────────────────────────────────────

/**
 * Eine Nudge-Klasse beschreibt, WIE eine Lane (oder UI-Surface) das envelope
 * priorisieren soll:
 *
 *   - urgent          — Deadline/Notfall-Marker; Surface SOLL pushen.
 *   - decision-needed — Frage/Approval-Marker; gehört in Open-Questions.
 *   - info-only       — deklarativ, keine Aktion nötig.
 *   - noise           — kein Signal (z.B. „ok", „danke"), kann ignoriert
 *                       werden.
 */
export type NudgeClass =
  | "urgent"
  | "decision-needed"
  | "info-only"
  | "noise";

export const NUDGE_CLASSES: readonly NudgeClass[] = [
  "urgent",
  "decision-needed",
  "info-only",
  "noise",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// ClassificationStatus — §7.3 No-auto-run-State-Machine
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle des intake_events-Row. Der Status ist die FSM, die §7.3
 * implementiert — bewusst KEIN automatischer Übergang zu „accepted"
 * (Schritt 6: „Erst nach Freigabe").
 *
 *   - staged             — Schritt 1 fertig (verbatim persistiert).
 *   - classified         — Schritt 3 fertig (nudgeClass gesetzt).
 *   - ready-for-compile  — Schritt 4 fertig (Kandidaten extrahiert; Lane B
 *                          darf hier abholen). KEIN auto-run nach Lane B.
 *   - blocked            — Consent denied oder Lane G no-auto-run-Gate hat
 *                          abgelehnt. Audit-Row geschrieben (N8).
 */
export type ClassificationStatus =
  | "staged"
  | "classified"
  | "ready-for-compile"
  | "blocked";

export const CLASSIFICATION_STATUSES: readonly ClassificationStatus[] = [
  "staged",
  "classified",
  "ready-for-compile",
  "blocked",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// IntakeEvent — der projektierte Row, wie er aus intake_events kommt
// ───────────────────────────────────────────────────────────────────────────

/**
 * 1:1 Projektion von intake_events (Migration 0119).
 *
 * Felder, die nur durch die Pipeline gesetzt werden (nudgeClass, status),
 * sind nach Schritt 3/4 belegt — vor Schritt 3 sind sie noch null bzw.
 * 'staged'.
 */
export interface IntakeEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly externalId: string | null;
  readonly dataSource: DataSource;
  readonly speakerExternalId: string | null;
  readonly speakerLocalId: string | null;
  readonly receivedAt: number;
  readonly sensitivity: IntakeSensitivity;
  readonly rawContent: string;
  readonly rawContentType: RawContentType;
  readonly parentEnvelopeId: string | null;
  readonly nudgeClass: NudgeClass | null;
  readonly classificationStatus: ClassificationStatus;
  readonly contentHash: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Candidates — §7.3 Schritt 4 (Begriffe · Entscheidungen · Fragen · Konflikte)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Deterministisch extrahierte Marker (KEIN LLM — das ist Lane B):
 *
 *   - urls       — vollständige http(s)://-URLs.
 *   - mentions   — `@handle` / `@person`.
 *   - questions  — Sätze, die mit `?` enden.
 *   - decisions  — Sätze, die ein Entscheidungs-Verb tragen
 *                  (entscheiden/decide/approval/freigabe/sign-off …).
 *   - conflicts  — Sätze, die ein Konflikt-Signal tragen
 *                  (aber/jedoch/contrary/widerspruch/blocker …).
 *   - decisionKeywords — VERBATIM Substring-Matches (z.B. „freigabe").
 *   - conflictKeywords — VERBATIM Substring-Matches (z.B. „widerspruch").
 *
 * Reihenfolge der Listen ist die Reihenfolge des Auftretens im Rohinhalt
 * (deterministisch, N6) — Tests können auf exakte Indexe matchen.
 */
export interface IntakeCandidates {
  readonly urls: readonly string[];
  readonly mentions: readonly string[];
  readonly questions: readonly string[];
  readonly decisions: readonly string[];
  readonly conflicts: readonly string[];
  readonly decisionKeywords: readonly string[];
  readonly conflictKeywords: readonly string[];
}

export const EMPTY_INTAKE_CANDIDATES: IntakeCandidates = Object.freeze({
  urls: Object.freeze([]) as readonly string[],
  mentions: Object.freeze([]) as readonly string[],
  questions: Object.freeze([]) as readonly string[],
  decisions: Object.freeze([]) as readonly string[],
  conflicts: Object.freeze([]) as readonly string[],
  decisionKeywords: Object.freeze([]) as readonly string[],
  conflictKeywords: Object.freeze([]) as readonly string[],
});

// ───────────────────────────────────────────────────────────────────────────
// IntakeResult — was die Pipeline zurückgibt
// ───────────────────────────────────────────────────────────────────────────

/**
 * Ergebnis von `runIntakePipeline`. Wenn `status='blocked'` → `blockedReason`
 * verbatim und KEIN Insert in intake_events; stattdessen Audit-Row.
 */
export interface IntakeResult {
  readonly status: ClassificationStatus;
  /** Der angelegte / vorhandene intake_events-Row (auch bei blocked, wenn die Row vor dem Block schon gestaged war). */
  readonly event: IntakeEvent | null;
  readonly candidates: IntakeCandidates;
  readonly nudgeClass: NudgeClass | null;
  /** Wenn blocked: verbatim Grund (N1) für Owner/Audit. */
  readonly blockedReason: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Pipeline-Optionen
// ───────────────────────────────────────────────────────────────────────────

/**
 * Optionen für runIntakePipeline. Bewusst minimal — die Pipeline ist eine
 * pure Funktion mit einem rohen DB-Handle.
 *
 *   - `userId`              — die Person, die als Akteur in Audit-Rows landet
 *                             (≠ speaker; das ist der angemeldete User der
 *                             eine API-Route triggert). Pflicht.
 *   - `consentGranted`      — Vom Caller (API-Route) vorab via hasConsent()
 *                             ermittelt. Lane A liest die DB nicht selbst,
 *                             damit die Pipeline pure bleibt.
 *   - `humanApproved`       — Hat der User Lane G's Bridge bereits explizit
 *                             zugestimmt? (canAutoRun-Argument).
 *   - `permissionMode`      — Aktueller Workspace-Permission-Mode (canAutoRun-
 *                             Argument).
 *   - `targetAction`        — Welche Action soll Lane A gegen Lane G prüfen?
 *                             Default 'persist-belief' (workspace-internal).
 *                             Wenn der Caller weiß, dass er bereits Lane B
 *                             spawnt, kann er 'spawn-subagent' setzen.
 */
export interface RunIntakePipelineOpts {
  readonly userId: string;
  readonly consentGranted: boolean;
  readonly humanApproved?: boolean;
  readonly permissionMode?:
    | "freerein"
    | "freerein-with-audit"
    | "lane"
    | "ask";
  readonly targetAction?: "persist-belief" | "spawn-subagent";
  /** Override für Test-Reproduktion (createdAt/updatedAt). Default Date.now(). */
  readonly nowMs?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Event-Typen, die Lane A emittiert (über lib/events/emit.ts)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lane A emittiert ausschließlich diese drei Event-Typen über das Event-Log
 * (lib/events/emit.ts). Der eventType-String ist die Wahrheit; die Konstante
 * existiert zur Referenz in Tests + Lane-Contract.
 *
 * HINWEIS: emit.ts hat eine eigene EventType-Union, die unsere Strings noch
 * nicht kennt. Wir emittieren die Events trotzdem über emitEvent (mit einem
 * gezielten as-Cast in der Pipeline), damit a) die Daten ankommen, b) der
 * String stabil ist. Eine Erweiterung der EventType-Union ist Lane-übergreifend
 * (Lane B+C reference dieselben Strings) und wird separat additiv eingebaut —
 * Lane A führt die Strings hier als Source-of-Truth ein.
 */
export const INTAKE_EVENT_TYPES = {
  received: "intake_event_received",
  classified: "intake_event_classified",
  readyForCompile: "intake_event_ready_for_compile",
} as const;

export type IntakeEventType =
  (typeof INTAKE_EVENT_TYPES)[keyof typeof INTAKE_EVENT_TYPES];
