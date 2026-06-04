/**
 * Lane F — Mobile Human-in-the-Loop · DETERMINISTISCHE Engine
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.3 · 2026-05-29 · Lanes-C/E/F-Engines.
 *
 * Master-Kontext §5 Lane F (verbatim, N1):
 *   „Ziel: Kunden und Agentur dort abholen, wo Kommunikation wirklich passiert.
 *    Output: hold-reply flow · pre-send nudge · decision card · context digest ·
 *    ask-customer action · push rules · mobile surface contract"
 * Integration-Plan §4 Lane F Repo-Anker (verbatim, N1):
 *   „push · pwa · surface-renderer · open-questions · answer_required"
 *
 * ── N6 + N4 KERN-ENTSCHEIDUNG ─────────────────────────────────────────────
 *   Lane F braucht KEIN LLM. Hold-reply, pre-send-nudge, push-rule-class und
 *   die decision-card-Payload sind DETERMINISTISCHE Klassifikationen (N6:
 *   deterministische Validatoren vor symbolischem Reasoning). Sie setzen auf
 *   dem BESTEHENDEN Push-Substrat auf (N4):
 *     - PushPriority / PushNotification / RuleRateLimit / dedupKeyWithPriority
 *       aus lib/push/rules.ts (KEIN neuer Push-Stack),
 *     - das answer_required-Vokabular ('approval'|'connector-preview'|
 *       'open-questions'|'run-stuck') aus lib/push/triggers.ts.
 *
 *   Diese Datei erfindet KEINE neue Notification-Zustellung — sie KLASSIFIZIERT
 *   einen HITL-Anlass und baut eine PushNotification + Priority + dedup/rate,
 *   die der bestehende dispatchPushTriggers-/emitAnswerRequired-Pfad zustellt.
 *
 * ── DISZIPLIN ─────────────────────────────────────────────────────────────
 *   - N1:  preview / Kontext werden VERBATIM uebernommen (firstLine ist eine
 *          BANNER-Projektion fuer den Lock-Screen, NICHT der gespeicherte Wert;
 *          die persistierte hitl-rule traegt den vollen verbatim Text).
 *   - N4:  baut auf lib/push/* auf; kein neuer Push-Stack.
 *   - N6:  rein deterministisch, kein LLM, kein Raten.
 *   - N8/N9/N10: Persistenz via insertLaneArtifact (append-only, scope, hash).
 */

import {
  insertLaneArtifact,
  type LaneArtifact,
} from "../lane-artifacts-repo";
import type {
  PushNotification,
  PushPriority,
  RuleRateLimit,
} from "@/lib/push/rules";

type RawDb = import("better-sqlite3").Database;

// ───────────────────────────────────────────────────────────────────────────
// HITL-Anlass-Taxonomie (deterministisch, an answer_required angelehnt — N4)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Die HITL-Anlaesse. Bewusst kongruent zum bestehenden answer_required-kind-
 * Vokabular (lib/push/triggers.ts) PLUS die Lane-F-spezifischen Owner-/Kunden-
 * Interaktionen (§5 Lane F: pre-send nudge, ask-customer).
 */
export type HitlOccasion =
  | "approval" // Plan/Subplan wartet auf Owner-Freigabe (= answer_required 'approval')
  | "connector-preview" // Externer Call wartet auf Freigabe (= 'connector-preview')
  | "open-questions" // Offene Fragen warten auf Antwort (= 'open-questions')
  | "run-stuck" // Lauf gestoppt, Owner muss entscheiden (= 'run-stuck')
  | "pre-send-nudge" // Nachricht an Kunde ist gleich raus — letzte Kontrolle (§5)
  | "ask-customer"; // Rueckfrage an den Kunden noetig (§5)

export const HITL_OCCASIONS: readonly HitlOccasion[] = [
  "approval",
  "connector-preview",
  "open-questions",
  "run-stuck",
  "pre-send-nudge",
  "ask-customer",
] as const;

const OCCASION_SET = new Set<string>(HITL_OCCASIONS);

/**
 * Irreversibilitaet/Trust-Gewicht je Anlass (Master-Kontext §3: „Menschliche
 * Gates bleiben Pflicht bei Consent, Trust, Expertenkorrektur, irreversiblen
 * Aktionen und Live-Calls."). Bestimmt deterministisch Push-Prioritaet + ob
 * hold-reply Pflicht ist.
 */
const OCCASION_WEIGHT: Readonly<Record<HitlOccasion, {
  /** true = irreversibel/extern/live → MUSS vor dem Senden ein Gate (hold-reply). */
  blocking: boolean;
  priority: PushPriority;
}>> = Object.freeze({
  // Externe/irreversible Aktionen: blockierend, hoechste Prio.
  "connector-preview": { blocking: true, priority: "p0" },
  "pre-send-nudge": { blocking: true, priority: "p0" },
  // Owner-Entscheidungen, die den Lauf gaten: blockierend, Standard-Prio.
  approval: { blocking: true, priority: "p1" },
  "run-stuck": { blocking: true, priority: "p1" },
  "ask-customer": { blocking: true, priority: "p1" },
  // Reine Informations-/Antwort-Anlaesse: nicht-blockierend.
  "open-questions": { blocking: false, priority: "p1" },
});

// ───────────────────────────────────────────────────────────────────────────
// 1. hold-reply — soll die Antwort/Aktion VOR dem Senden gehalten werden?
// ───────────────────────────────────────────────────────────────────────────

export interface HoldReplyInput {
  readonly occasion: HitlOccasion;
  /**
   * Erkannt-irreversibel? Override aus dem Aufrufer (z.B. „diese Mail geht an
   * den Kunden raus"). true erzwingt hold unabhaengig vom Anlass-Default.
   */
  readonly irreversible?: boolean;
  /** Hat der Owner fuer diesen Workspace Auto-Send freigegeben? (default false → sicher) */
  readonly autoSendApproved?: boolean;
}

export interface HoldReplyDecision {
  /** true = Antwort/Aktion wird gehalten; ein Gate (decision-card) ist Pflicht. */
  readonly hold: boolean;
  /** Verbatim-Begruendung (N1) — landet im Audit/Trace. */
  readonly reason: string;
}

/**
 * Deterministisch (N6): entscheidet, ob eine Antwort/Aktion VOR dem Senden
 * gehalten wird. Fail-CLOSED: unbekannter Anlass → hold=true (sicher).
 *
 * Regel:
 *   - irreversible=true                  → IMMER hold (§3 irreversible Aktion).
 *   - Anlass ist blocking + NICHT autoSendApproved → hold.
 *   - blocking + autoSendApproved        → kein hold (Owner hat entkoppelt),
 *     AUSSER der Anlass ist extern/live (connector-preview/pre-send-nudge):
 *     die bleiben IMMER gated (§3 Live-Call/irreversibel).
 *   - nicht-blocking                     → kein hold.
 */
export function holdReply(input: HoldReplyInput): HoldReplyDecision {
  if (typeof input.occasion !== "string" || !OCCASION_SET.has(input.occasion)) {
    return {
      hold: true,
      reason: `unknown occasion '${String(input.occasion)}' → fail-closed hold (N6)`,
    };
  }
  if (input.irreversible === true) {
    return { hold: true, reason: "irreversible action → mandatory hold (§3)" };
  }
  const w = OCCASION_WEIGHT[input.occasion];
  if (!w.blocking) {
    return { hold: false, reason: `occasion '${input.occasion}' is non-blocking` };
  }
  // Extern/Live ist NIE auto-send-faehig (§3).
  const alwaysGated =
    input.occasion === "connector-preview" ||
    input.occasion === "pre-send-nudge";
  if (alwaysGated) {
    return {
      hold: true,
      reason: `occasion '${input.occasion}' is external/live → always gated (§3)`,
    };
  }
  if (input.autoSendApproved === true) {
    return {
      hold: false,
      reason: `occasion '${input.occasion}' blocking but owner approved auto-send`,
    };
  }
  return {
    hold: true,
    reason: `occasion '${input.occasion}' is blocking → hold until owner decides`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 2. pre-send-nudge — letzte Kontroll-Aufforderung VOR dem Senden an den Kunden
// ───────────────────────────────────────────────────────────────────────────

export interface PreSendNudgeInput {
  /** Verbatim der zu sendende Inhalt (N1) — wird NICHT mutiert. */
  readonly draft: string;
  /** An wen geht die Nachricht (z.B. Kundenname/Kanal). */
  readonly recipient?: string;
  /** Deep-Link zur Review-Card. */
  readonly url?: string;
}

export interface PreSendNudge {
  /** Lock-Screen-taugliche Notification (N4: PushNotification aus lib/push). */
  readonly notification: PushNotification;
  /** Immer p0 — pre-send ist die letzte Chance vor einer externen Aktion. */
  readonly priority: PushPriority;
  /** Verbatim-Draft (N1) — fuer die decision-card; NICHT gekuerzt. */
  readonly draftVerbatim: string;
}

/** Lock-Screen-Projektion: erste Zeile, gekappt. NICHT der gespeicherte Wert (N1). */
function bannerLine(s: string, max = 100): string {
  const line = (s.split("\n")[0] ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Deterministisch (N6): baut die Pre-Send-Nudge. Der draft bleibt VERBATIM
 * (N1); nur die Banner-Zeile ist eine gekappte Projektion fuer den Lock-Screen.
 */
export function preSendNudge(input: PreSendNudgeInput): PreSendNudge {
  if (typeof input.draft !== "string" || input.draft.length === 0) {
    throw new Error("preSendNudge: draft required (N1)");
  }
  const to = input.recipient ? ` an ${input.recipient}` : "";
  return {
    notification: {
      title: `Senden${to}? — letzte Kontrolle`,
      body: bannerLine(input.draft),
      url: input.url ?? "/",
      tag: `pre-send${input.recipient ? `-${input.recipient}` : ""}`,
    },
    priority: "p0",
    draftVerbatim: input.draft, // N1: verbatim, kein slice
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 3. decision-card payload — die mobile Surface-Payload (§5 decision card)
// ───────────────────────────────────────────────────────────────────────────

export interface DecisionCardInput {
  readonly occasion: HitlOccasion;
  /** Verbatim-Kontext, der dem Owner gezeigt wird (N1) — NICHT gekuerzt. */
  readonly context: string;
  /** Owner-Optionen (z.B. ['Freigeben','Ablehnen','Bearbeiten']). */
  readonly options?: readonly string[];
  readonly url?: string;
  readonly entityId?: string;
}

/**
 * Die mobile-surface-contract-Payload (§5). Bewusst kongruent zur bestehenden
 * answer_required/open-questions-Surface-Form, damit der SurfaceRenderer sie
 * ohne neue Surface-Familie rendern kann (N4).
 */
export interface DecisionCardPayload {
  readonly surfaceKind: "decision-card";
  readonly occasion: HitlOccasion;
  /** Verbatim (N1). */
  readonly context: string;
  readonly options: readonly string[];
  /** true = der Owner MUSS entscheiden, bevor es weitergeht. */
  readonly blocking: boolean;
  readonly priority: PushPriority;
  readonly url: string;
  readonly entityId: string | null;
}

/**
 * Deterministisch (N6): baut die decision-card-Payload. fail-closed bei
 * unbekanntem Anlass (blocking=true). options default je Anlass.
 */
export function decisionCardPayload(
  input: DecisionCardInput,
): DecisionCardPayload {
  if (typeof input.context !== "string" || input.context.length === 0) {
    throw new Error("decisionCardPayload: context required (N1)");
  }
  const known = OCCASION_SET.has(input.occasion);
  const w = known ? OCCASION_WEIGHT[input.occasion] : null;
  const options =
    input.options && input.options.length > 0
      ? [...input.options]
      : defaultOptions(input.occasion);
  return {
    surfaceKind: "decision-card",
    occasion: input.occasion,
    context: input.context, // N1: verbatim
    options,
    blocking: w ? w.blocking : true, // fail-closed
    priority: w ? w.priority : "p1",
    url: input.url ?? "/",
    entityId: input.entityId ?? null,
  };
}

function defaultOptions(occasion: HitlOccasion): string[] {
  switch (occasion) {
    case "approval":
      return ["Freigeben", "Ablehnen", "Bearbeiten"];
    case "connector-preview":
      return ["Senden", "Abbrechen"];
    case "pre-send-nudge":
      return ["Jetzt senden", "Bearbeiten", "Abbrechen"];
    case "open-questions":
      return ["Beantworten"];
    case "run-stuck":
      return ["Neu starten", "Abbrechen"];
    case "ask-customer":
      return ["Kunde fragen", "Selbst entscheiden"];
    default:
      return ["Entscheiden"];
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 4. push-rule-class — deterministische Push-Klassifikation (N4 auf lib/push)
// ───────────────────────────────────────────────────────────────────────────

export interface PushRuleClass {
  readonly occasion: HitlOccasion;
  readonly priority: PushPriority;
  readonly rateLimit: RuleRateLimit;
  /**
   * Dedup-Schluessel-Praefix — der Aufrufer haengt die entityId/workspaceId an
   * (kongruent zu lib/push/rules.ts dedupKey-Konvention). N4: KEIN neuer
   * Dedup-Mechanismus.
   */
  readonly dedupPrefix: string;
  /** Spiegelt holdReply().hold fuer den default-Fall (kein autoSendApproved). */
  readonly blocking: boolean;
}

/**
 * Deterministisch (N6): klassifiziert einen HITL-Anlass in eine Push-Klasse
 * (Prioritaet + Rate-Limit + Dedup-Praefix), die der bestehende
 * dispatchPushTriggers-/Dedup-/Cap-Pfad (lib/push) konsumiert. fail-closed:
 * unbekannter Anlass → p1, eng-limitiert, blocking.
 */
export function pushRuleClass(occasion: HitlOccasion): PushRuleClass {
  if (!OCCASION_SET.has(occasion)) {
    return {
      occasion,
      priority: "p1",
      rateLimit: { per: "hour", max: 4 },
      dedupPrefix: `hitl-unknown`,
      blocking: true,
    };
  }
  const w = OCCASION_WEIGHT[occasion];
  // Rate-Limits deterministisch je Anlass — kongruent zu den bestehenden
  // answer_required-Rules in lib/push/rules.ts (per hour, kleine max).
  const rateLimit: RuleRateLimit =
    w.priority === "p0"
      ? { per: "hour", max: 10 }
      : occasion === "open-questions"
        ? { per: "hour", max: 6 }
        : { per: "hour", max: 10 };
  return {
    occasion,
    priority: w.priority,
    rateLimit,
    dedupPrefix: `hitl-${occasion}`,
    blocking: w.blocking,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 5. Persistenz — eine hitl-rule als lane_artifacts-Row (N8/N9/N10)
// ───────────────────────────────────────────────────────────────────────────

export interface PersistHitlRuleInput {
  readonly workspaceId: string;
  readonly occasion: HitlOccasion;
  /** Verbatim-Kontext/Begruendung (N1). */
  readonly context: string;
  readonly entityId?: string | null;
  readonly nowMs?: number;
}

/**
 * Persistiert die deterministische HITL-Klassifikation eines Anlasses als EINE
 * lane_artifacts(kind='hitl-rule')-Row (append-only, idempotent, content_hash).
 * Speichert die volle deterministische Ableitung (hold/priority/rate/blocking)
 * als source_json — der spaetere dispatchPushTriggers-Pfad liest sie.
 */
export function persistHitlRule(
  raw: RawDb,
  input: PersistHitlRuleInput,
): LaneArtifact {
  if (typeof input.workspaceId !== "string" || input.workspaceId.length === 0) {
    throw new Error("persistHitlRule: workspaceId required (N9)");
  }
  if (typeof input.context !== "string" || input.context.length === 0) {
    throw new Error("persistHitlRule: context required (N1)");
  }
  const cls = pushRuleClass(input.occasion);
  const hold = holdReply({ occasion: input.occasion });
  return insertLaneArtifact(raw, {
    workspaceId: input.workspaceId,
    kind: "hitl-rule",
    content: input.context, // N1 verbatim
    source: {
      occasion: input.occasion,
      hold: hold.hold,
      holdReason: hold.reason,
      priority: cls.priority,
      rateLimit: cls.rateLimit,
      dedupPrefix: cls.dedupPrefix,
      blocking: cls.blocking,
      entityId: input.entityId ?? null,
    },
    nowMs: input.nowMs,
  });
}
