/**
 * Lane A — Communication Intake · Nudge-Classifier
 * ════════════════════════════════════════════════════════════════════════
 *
 * Phase 2 W2.2 · 2026-05-29.
 *
 * Master-Briefing §25.1 (verbatim, N1):
 *   „Artefakte: … Nudge-Klassen."
 * Master-Briefing §7.3 Schritt 3 (verbatim, N1):
 *   „Klassifizieren."
 *
 * Deterministisch (N6) — regex- und keyword-basierte Klassifikation in DE+EN.
 * KEIN LLM. Wenn mehrere Klassen treffen, gilt diese Priorität (verbatim):
 *
 *     urgent  >  decision-needed  >  info-only  >  noise
 *
 * Die Priorität reflektiert den Schadens-Verlauf: wir wollen lieber einen
 * „noise"-Eintrag fälschlich als „urgent" klassifizieren (User-Aufmerksamkeit
 * verbraucht) als eine echte Notfall-Meldung als „info-only" überhören.
 *
 * Keywords sind VERBATIM Substrings (lower-cased compare). Sie sind absichtlich
 * konservativ klein gehalten — Lane B (Expertise-Compiler) wird über LLM
 * tiefer reinhören; Lane A liefert nur das Bottom-Line-Signal.
 */

import type { NudgeClass, SourceEnvelope } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// Keyword-Listen (verbatim Substrings, lower-cased compare)
// ───────────────────────────────────────────────────────────────────────────

/**
 * URGENT — Notfall/Deadline-Marker (DE+EN). Substring-Match.
 * Achtung: bewusst kein einzelnes "now" — das wäre ein zu starker
 * False-Positive-Magnet. „jetzt sofort" / „right now" sind die enger
 * gefassten Varianten.
 */
const URGENT_KEYWORDS: readonly string[] = [
  "urgent",
  "asap",
  "deadline",
  "today",
  "jetzt sofort",
  "right now",
  "notfall",
  "emergency",
  "critical",
  "kritisch",
  "immediately",
  "sofort dringend",
  "p0",
  "p1-incident",
] as const;

/**
 * DECISION-NEEDED — Entscheidungs-/Approval-Marker. Substring-Match.
 * Es genügt EINE dieser Phrasen ODER ein Fragezeichen (siehe regex unten).
 */
const DECISION_KEYWORDS: readonly string[] = [
  "entscheid", // entscheid·ung / entscheid·en
  "decide",
  "decision",
  "approval",
  "approve",
  "freigabe",
  "sign-off",
  "signoff",
  "go/no-go",
  "bitte bestätig", // matches „bitte bestätige", „bitte bestätigen Sie"
  "please confirm",
  "please approve",
  "soll ich", // typische deutsche Entscheidungs-Anfrage
  "should i",
  "should we",
] as const;

/**
 * Action-Verben (DE+EN), die ein Imperativ-/Aktions-Signal tragen — wird
 * für die info-only-vs-noise-Disambiguation gebraucht.
 *
 * Substring-Match. Diese Liste ist absichtlich klein; Edge-Cases werden
 * lieber als info-only klassifiziert als als noise.
 */
const ACTION_VERBS: readonly string[] = [
  "send",
  "mach",
  "build",
  "deploy",
  "fix",
  "schick",
  "ruf an",
  "call",
  "schreib",
  "implement",
  "test",
  "review",
  "merge",
  "release",
  "kauf",
  "buy",
  "bestell",
  "order",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Regex-Indikatoren
// ───────────────────────────────────────────────────────────────────────────

/** Mindestens ein Fragezeichen → Decision-/Question-Indikator. */
const QUESTION_MARK_RE = /\?/;

/** Wort-Tokenizer für length-Heuristiken (≥ 3 chars zählt als Wort). */
const WORD_RE = /\b[\p{L}\p{N}'_-]{3,}\b/gu;

// ───────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen
// ───────────────────────────────────────────────────────────────────────────

function lower(s: string): string {
  return s.toLowerCase();
}

function anyKeywordMatches(text: string, keywords: readonly string[]): boolean {
  const t = lower(text);
  for (const kw of keywords) {
    if (t.includes(kw)) return true;
  }
  return false;
}

function countWords(text: string): number {
  // Reset is implicit because we recreate matchAll iter each call.
  const matches = text.match(WORD_RE);
  return matches ? matches.length : 0;
}

// ───────────────────────────────────────────────────────────────────────────
// classify — Hauptfunktion
// ───────────────────────────────────────────────────────────────────────────

/**
 * Klassifiziert ein envelope deterministisch in eine NudgeClass.
 *
 * Implementiert die Priorität:
 *   urgent > decision-needed > info-only > noise
 *
 * Heuristik in Worten:
 *   1. Wenn URGENT_KEYWORDS matchen → 'urgent'.
 *   2. Sonst, wenn ein '?' im Text steht ODER DECISION_KEYWORDS matchen →
 *      'decision-needed'.
 *   3. Sonst, wenn der Text ≥ 3 Wörter HAT UND mindestens ein Action-Verb
 *      trägt → 'info-only' (er trägt zwar keine Frage, aber etwas
 *      Beobachtbares/Imperativisches). Auch reine deklarative Sätze ohne
 *      Verb gelten als info-only, sobald sie ≥ 5 Wörter sind (eine echte
 *      Aussage, kein Filler).
 *   4. Sonst → 'noise'.
 *
 * Eingabe ist ein SourceEnvelope; die Klassifikation berücksichtigt nur
 * `rawContent` (sensitivity, dataSource etc. werden bewusst nicht hier
 * gemixt — sie sind Substrat, nicht Signal).
 *
 * Niemals werfen — fail-soft. Leerer / nicht-Text-Inhalt → 'noise'.
 */
export function classify(envelope: SourceEnvelope): NudgeClass {
  if (!envelope || typeof envelope !== "object") return "noise";
  const raw = envelope.rawContent;
  if (typeof raw !== "string" || raw.length === 0) return "noise";
  // Nicht-text-Content-Types: wir HABEN keinen aussagekräftigen Text
  // (Audio/Video/Image wären transkribiert; sonst sehen wir nur eine URL).
  // Trotzdem klassifizieren wir den begleitenden Caption-Text — falls keiner
  // da ist, fällt es unten auf noise zurück.

  // (1) URGENT
  if (anyKeywordMatches(raw, URGENT_KEYWORDS)) {
    return "urgent";
  }

  // (2) DECISION-NEEDED
  if (QUESTION_MARK_RE.test(raw) || anyKeywordMatches(raw, DECISION_KEYWORDS)) {
    return "decision-needed";
  }

  // (3) INFO-ONLY oder NOISE
  const wc = countWords(raw);
  const hasActionVerb = anyKeywordMatches(raw, ACTION_VERBS);
  if (wc >= 3 && hasActionVerb) return "info-only";
  if (wc >= 5) return "info-only";

  return "noise";
}

/**
 * Re-export der Keyword-Listen für externe Konsumenten (Tests, Lane-Contract).
 * Konstanten sind read-only.
 */
export const NUDGE_KEYWORDS = {
  urgent: URGENT_KEYWORDS,
  decisionNeeded: DECISION_KEYWORDS,
  actionVerbs: ACTION_VERBS,
} as const;
