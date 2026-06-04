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
 * Deterministic (N6) — regex- and keyword-based classification in DE+EN.
 * NO LLM. When multiple classes match, this priority applies (verbatim):
 *
 *     urgent  >  decision-needed  >  info-only  >  noise
 *
 * The priority reflects the damage profile: we would rather misclassify a
 * „noise" entry as „urgent" (consuming user attention) than miss a real
 * emergency message as „info-only".
 *
 * Keywords are VERBATIM substrings (lower-cased compare). They are deliberately
 * kept conservatively small — Lane B (Expertise-Compiler) will listen in more
 * deeply via LLM; Lane A only delivers the bottom-line signal.
 */

import type { NudgeClass, SourceEnvelope } from "./types";

// ───────────────────────────────────────────────────────────────────────────
// Keyword lists (verbatim substrings, lower-cased compare)
// ───────────────────────────────────────────────────────────────────────────

/**
 * URGENT — emergency/deadline markers (DE+EN). Substring match.
 * Note: deliberately no single "now" — that would be too strong a
 * false-positive magnet. „jetzt sofort" / „right now" are the more narrowly
 * scoped variants.
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
 * DECISION-NEEDED — decision/approval markers. Substring match.
 * ONE of these phrases OR a question mark (see regex below) suffices.
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
  "soll ich", // typical German decision request
  "should i",
  "should we",
] as const;

/**
 * Action verbs (DE+EN) that carry an imperative/action signal — needed
 * for the info-only-vs-noise disambiguation.
 *
 * Substring match. This list is deliberately small; edge cases are
 * classified as info-only rather than noise.
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
// Regex indicators
// ───────────────────────────────────────────────────────────────────────────

/** At least one question mark → decision/question indicator. */
const QUESTION_MARK_RE = /\?/;

/** Word tokenizer for length heuristics (≥ 3 chars counts as a word). */
const WORD_RE = /\b[\p{L}\p{N}'_-]{3,}\b/gu;

// ───────────────────────────────────────────────────────────────────────────
// Helper functions
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
// classify — main function
// ───────────────────────────────────────────────────────────────────────────

/**
 * Classifies an envelope deterministically into a NudgeClass.
 *
 * Implements the priority:
 *   urgent > decision-needed > info-only > noise
 *
 * Heuristic in words:
 *   1. If URGENT_KEYWORDS match → 'urgent'.
 *   2. Otherwise, if a '?' is in the text OR DECISION_KEYWORDS match →
 *      'decision-needed'.
 *   3. Otherwise, if the text HAS ≥ 3 words AND carries at least one action
 *      verb → 'info-only' (it carries no question, but something
 *      observable/imperative). Pure declarative sentences without
 *      a verb also count as info-only once they are ≥ 5 words (a real
 *      statement, not filler).
 *   4. Otherwise → 'noise'.
 *
 * The input is a SourceEnvelope; the classification considers only
 * `rawContent` (sensitivity, dataSource etc. are deliberately not mixed in
 * here — they are substrate, not signal).
 *
 * Never throws — fail-soft. Empty / non-text content → 'noise'.
 */
export function classify(envelope: SourceEnvelope): NudgeClass {
  if (!envelope || typeof envelope !== "object") return "noise";
  const raw = envelope.rawContent;
  if (typeof raw !== "string" || raw.length === 0) return "noise";
  // Non-text content types: we HAVE no meaningful text
  // (audio/video/image would be transcribed; otherwise we only see a URL).
  // We still classify the accompanying caption text — if there is none,
  // it falls back to noise below.

  // (1) URGENT
  if (anyKeywordMatches(raw, URGENT_KEYWORDS)) {
    return "urgent";
  }

  // (2) DECISION-NEEDED
  if (QUESTION_MARK_RE.test(raw) || anyKeywordMatches(raw, DECISION_KEYWORDS)) {
    return "decision-needed";
  }

  // (3) INFO-ONLY or NOISE
  const wc = countWords(raw);
  const hasActionVerb = anyKeywordMatches(raw, ACTION_VERBS);
  if (wc >= 3 && hasActionVerb) return "info-only";
  if (wc >= 5) return "info-only";

  return "noise";
}

/**
 * Re-export of the keyword lists for external consumers (tests, lane contract).
 * The constants are read-only.
 */
export const NUDGE_KEYWORDS = {
  urgent: URGENT_KEYWORDS,
  decisionNeeded: DECISION_KEYWORDS,
  actionVerbs: ACTION_VERBS,
} as const;
