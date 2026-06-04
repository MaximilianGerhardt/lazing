/**
 * lib/chat/bug-swarm-detection.ts
 * --------------------------------
 * Sprint H · 2026-04-30 — Bug-Fix-Swarm Trigger.
 *
 * Pure function: heuristically detects whether a user message is a bug/error
 * report and a 3-model diagnosis swarm should be started.
 *
 * User complaint 2026-04-30 (verbatim):
 *   „Bug rein, der labert da rum, statt selber zu fixen... Auch hier hätte
 *   ich mir eine Swarming-Analyse gewünscht — 2-3 Modelle wenn die nichts
 *   finden oder konsens haben weiter."
 *
 * Strategy:
 *   1. Bypass check: does the message start with `/no-swarm`? -> skip detection,
 *      remove the marker, treat normally as a chat message.
 *   2. Keyword scan: typical error/bug indicators in the text.
 *   3. Pattern scan: stack-trace-like lines (`at Foo (file:line:col)`,
 *      `TypeError: ...`, etc.).
 *   4. Enough substance: empty/ultra-short text does NOT trigger (otherwise
 *      it confuses users who just want to type "error" without context).
 *
 * No regex magic behind the user's back — if the heuristic is off,
 * the user can bypass with `/no-swarm <text>`, or close the card
 * immediately with cancel.
 */

const BUG_KEYWORDS = [
  // explicit
  'bug',
  'error',
  'fail',
  'failed',
  'failure',
  'crash',
  'crashed',
  'exception',
  'broken',
  'kaputt',
  'fehler',
  'fehlschlag',
  'absturz',
  'stack trace',
  'stacktrace',
  'undefined is not',
  'cannot read',
  'cannot find',
  // Frameworks / Runtimes
  'segfault',
  'segmentation fault',
  'panic',
  'oom',
  'out of memory',
] as const;

const ERROR_TYPE_PATTERNS = [
  // JS/TS Errors
  /\bTypeError\s*:/i,
  /\bReferenceError\s*:/i,
  /\bSyntaxError\s*:/i,
  /\bRangeError\s*:/i,
  /\bURIError\s*:/i,
  /\bEvalError\s*:/i,
  // Generic patterns
  /\bError\s*:\s*[A-Za-z]/, // "Error: something"
  // Stack trace lines: "at Foo (file:123:45)" or "at file:123:45"
  /\bat\s+[\w.<>$]+\s*\([^)]*:\d+(?::\d+)?\)/,
  /\bat\s+[\w./\\-]+:\d+(?::\d+)?\b/,
  // Python tracebacks
  /Traceback\s*\(most recent call last\)/i,
  /\bFile\s+"[^"]+",\s+line\s+\d+/,
  // HTTP error codes in message
  /\b(?:5\d\d|4\d\d)\s+(?:Internal Server Error|Bad Request|Not Found|Unauthorized|Forbidden)/i,
] as const;

const NO_SWARM_PREFIX = '/no-swarm';

export interface BugDetectionResult {
  /** True if the heuristic detected a bug report. */
  isBug: boolean;
  /**
   * Cleaned message — if the user had `/no-swarm` as a prefix, the
   * marker was removed. Otherwise unchanged.
   */
  cleanedMessage: string;
  /**
   * True if the user explicitly used `/no-swarm` as a bypass.
   * The caller should then NOT start the swarm, even if `isBug` were
   * nominally true (semantically: bypass beats detection).
   */
  bypassedByUser: boolean;
  /**
   * Which indicators matched — for debugging/telemetry. Never shown to the user.
   */
  matchedSignals: ReadonlyArray<string>;
}

/**
 * Normalizes the message for detection. Removes leading whitespace
 * and checks for the `/no-swarm` bypass.
 */
function normalize(input: string): {
  cleanedMessage: string;
  bypassedByUser: boolean;
} {
  if (typeof input !== 'string') {
    return { cleanedMessage: '', bypassedByUser: false };
  }
  const trimmedStart = input.replace(/^\s+/, '');
  // Bypass: "/no-swarm <rest>" or "/no-swarm\n<rest>" or simply "/no-swarm".
  if (trimmedStart.toLowerCase().startsWith(NO_SWARM_PREFIX)) {
    const rest = trimmedStart.slice(NO_SWARM_PREFIX.length);
    // The next character must be whitespace or string-end, so
    // "/no-swarmage" does not accidentally match.
    if (rest.length === 0 || /^\s/.test(rest)) {
      return {
        cleanedMessage: rest.replace(/^\s+/, ''),
        bypassedByUser: true,
      };
    }
  }
  return { cleanedMessage: input, bypassedByUser: false };
}

/**
 * Heuristik: ist diese Message ein Bug-/Error-Report der einen 3-Modell-
 * Diagnose-Swarm rechtfertigt?
 *
 * Trigger logic:
 *   - bypass via /no-swarm        -> isBug=false (user wish)
 *   - empty or < 20 chars          -> isBug=false (too little substance)
 *   - at least 1 error-type pattern -> isBug=true
 *   - OR at least 2 bug keywords   -> isBug=true
 *   - otherwise                    -> isBug=false
 *
 * The "2 keywords" threshold prevents small talk like "I have an error
 * in my thinking" or "this is a bug-free design" from falsely triggering.
 */
export function detectBugReport(input: string): BugDetectionResult {
  const { cleanedMessage, bypassedByUser } = normalize(input);

  if (bypassedByUser) {
    return {
      isBug: false,
      cleanedMessage,
      bypassedByUser: true,
      matchedSignals: [],
    };
  }

  const trimmed = cleanedMessage.trim();
  if (trimmed.length < 20) {
    return {
      isBug: false,
      cleanedMessage,
      bypassedByUser: false,
      matchedSignals: [],
    };
  }

  const matched: string[] = [];
  const lower = trimmed.toLowerCase();

  for (const kw of BUG_KEYWORDS) {
    if (lower.includes(kw)) {
      matched.push(`kw:${kw}`);
    }
  }

  for (const pat of ERROR_TYPE_PATTERNS) {
    if (pat.test(trimmed)) {
      matched.push(`pat:${pat.source.slice(0, 30)}`);
    }
  }

  // A pattern match is very strong → 1 is enough.
  // A keyword match is weak → 2 minimum.
  const hasPatternMatch = matched.some((m) => m.startsWith('pat:'));
  const keywordCount = matched.filter((m) => m.startsWith('kw:')).length;

  const isBug = hasPatternMatch || keywordCount >= 2;

  return {
    isBug,
    cleanedMessage,
    bypassedByUser: false,
    matchedSignals: matched,
  };
}
