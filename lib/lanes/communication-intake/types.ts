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
 * This file declares the vocabulary of the source envelope, the nudge
 * classification, the candidate extraction and the pipeline results.
 *
 * Pure type module — no runtime imports, no side effects.
 *
 * SUBSTRATE (N4): table intake_events (Migration 0119). NO intervention in
 * workstream_decisions, workspace_beliefs or events. Lane A writes to
 * intake_events; Lane B (Expertise-Compiler) reads from it later.
 */

// ───────────────────────────────────────────────────────────────────────────
// DataSource — exactly the vocabulary from lib/governance/consent.ts (no drift)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Data sources that Lane A consumes. DELIBERATELY 1:1 congruent with
 * `ConsentLevel.DataSource` from lib/governance/consent.ts — Lane A delegates
 * consent checks to Lane G and must not allow anything Lane G does not know.
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
// Sensitivity — four-level scale, identical to the consent_grants.level spirit
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
// RawContentType — how the raw content is present
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
// SourceEnvelope — §7.3 steps 1+2 (store verbatim + source/speaker/
// time/project/sensitivity)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The envelope that carries every incoming communication in laz.ing.
 *
 * `rawContent` is VERBATIM (N1) — no truncation, no paraphrase. The
 * intake_events schema (Migration 0119) has NO TEXT(N) lengths.
 *
 * `contentHash` (N10) = sha256 over canonical JSON of the envelope identity
 * (externalId + dataSource + rawContent + receivedAt). This makes
 * idempotency achievable: the same input → the same hash → the same insert
 * (or an existing row, deduplicated).
 */
export interface SourceEnvelope {
  /** ID from the external system (whatsapp message id, telegram update id, …). */
  readonly externalId: string;
  readonly dataSource: DataSource;
  /** Who said it — external ID of the speaker/sender. */
  readonly speakerExternalId?: string;
  /** Mapped to the local user/contact (once the resolution kicks in). */
  readonly speakerLocalId?: string;
  /** ms-epoch. When the source originated (not: when we see it). */
  readonly receivedAt: number;
  readonly sensitivity: IntakeSensitivity;
  /** workspaceId — N9 ManifestCoord scope. */
  readonly projectScope: string;
  /** VERBATIM content (N1). NO slice. */
  readonly rawContent: string;
  readonly rawContentType: RawContentType;
  /** Reply/forward chain — soft FK to another envelope.id in the same workspace. */
  readonly parentEnvelopeId?: string;
  /** sha256 over canonical JSON (N10). */
  readonly contentHash: string;
}

// ───────────────────────────────────────────────────────────────────────────
// NudgeClass — §25.1 „Nudge-Klassen"
// ───────────────────────────────────────────────────────────────────────────

/**
 * A nudge class describes HOW a lane (or UI surface) should prioritize the
 * envelope:
 *
 *   - urgent          — deadline/emergency marker; the surface SHOULD push.
 *   - decision-needed — question/approval marker; belongs in Open-Questions.
 *   - info-only       — declarative, no action needed.
 *   - noise           — no signal (e.g. „ok", „danke"), can be
 *                       ignored.
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
 * Lifecycle of the intake_events row. The status is the FSM that §7.3
 * implements — deliberately NO automatic transition to „accepted"
 * (step 6: „Erst nach Freigabe").
 *
 *   - staged             — step 1 done (persisted verbatim).
 *   - classified         — step 3 done (nudgeClass set).
 *   - ready-for-compile  — step 4 done (candidates extracted; Lane B
 *                          may pick up here). NO auto-run after Lane B.
 *   - blocked            — consent denied or Lane G's no-auto-run gate has
 *                          rejected. Audit row written (N8).
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
// IntakeEvent — the projected row as it comes from intake_events
// ───────────────────────────────────────────────────────────────────────────

/**
 * 1:1 projection of intake_events (Migration 0119).
 *
 * Fields that are only set by the pipeline (nudgeClass, status)
 * are populated after step 3/4 — before step 3 they are still null or
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
// Candidates — §7.3 step 4 (terms · decisions · questions · conflicts)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Deterministically extracted markers (NO LLM — that is Lane B):
 *
 *   - urls       — full http(s):// URLs.
 *   - mentions   — `@handle` / `@person`.
 *   - questions  — sentences ending with `?`.
 *   - decisions  — sentences carrying a decision verb
 *                  (entscheiden/decide/approval/freigabe/sign-off …).
 *   - conflicts  — sentences carrying a conflict signal
 *                  (aber/jedoch/contrary/widerspruch/blocker …).
 *   - decisionKeywords — VERBATIM substring matches (e.g. „freigabe").
 *   - conflictKeywords — VERBATIM substring matches (e.g. „widerspruch").
 *
 * The order of the lists is the order of occurrence in the raw content
 * (deterministic, N6) — tests can match exact indexes.
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
// IntakeResult — what the pipeline returns
// ───────────────────────────────────────────────────────────────────────────

/**
 * Result of `runIntakePipeline`. When `status='blocked'` → `blockedReason`
 * verbatim and NO insert into intake_events; an audit row instead.
 */
export interface IntakeResult {
  readonly status: ClassificationStatus;
  /** The created / existing intake_events row (also on blocked, when the row was already staged before the block). */
  readonly event: IntakeEvent | null;
  readonly candidates: IntakeCandidates;
  readonly nudgeClass: NudgeClass | null;
  /** When blocked: verbatim reason (N1) for owner/audit. */
  readonly blockedReason: string | null;
}

// ───────────────────────────────────────────────────────────────────────────
// Pipeline options
// ───────────────────────────────────────────────────────────────────────────

/**
 * Options for runIntakePipeline. Deliberately minimal — the pipeline is a
 * pure function with a raw DB handle.
 *
 *   - `userId`              — the person who lands as the actor in audit rows
 *                             (≠ speaker; this is the signed-in user who
 *                             triggers an API route). Required.
 *   - `consentGranted`      — determined upfront by the caller (API route) via
 *                             hasConsent(). Lane A does not read the DB itself,
 *                             so the pipeline stays pure.
 *   - `humanApproved`       — has the user already explicitly agreed to Lane G's
 *                             Bridge? (canAutoRun argument).
 *   - `permissionMode`      — current workspace permission mode (canAutoRun
 *                             argument).
 *   - `targetAction`        — which action should Lane A check against Lane G?
 *                             Default 'persist-belief' (workspace-internal).
 *                             If the caller knows it is already spawning Lane B,
 *                             it can set 'spawn-subagent'.
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
  /** Override for test reproduction (createdAt/updatedAt). Default Date.now(). */
  readonly nowMs?: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Event types that Lane A emits (via lib/events/emit.ts)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Lane A emits exclusively these three event types via the event log
 * (lib/events/emit.ts). The eventType string is the truth; the constant
 * exists for reference in tests + the lane contract.
 *
 * NOTE: emit.ts has its own EventType union that does not yet know our
 * strings. We emit the events via emitEvent anyway (with a
 * targeted as-cast in the pipeline) so that a) the data arrives, b) the
 * string is stable. Extending the EventType union is cross-lane
 * (Lane B+C reference the same strings) and is added separately additively —
 * Lane A introduces the strings here as the source of truth.
 */
export const INTAKE_EVENT_TYPES = {
  received: "intake_event_received",
  classified: "intake_event_classified",
  readyForCompile: "intake_event_ready_for_compile",
} as const;

export type IntakeEventType =
  (typeof INTAKE_EVENT_TYPES)[keyof typeof INTAKE_EVENT_TYPES];
