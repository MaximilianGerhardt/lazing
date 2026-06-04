/**
 * lib/agents/bug-detector.ts
 * --------------------------
 * Sprint H+ · 2026-05-01 — Bug-fix pipeline phase 1 (detect).
 *
 * User complaint 2026-05-01 (verbatim):
 *   „bug fixes bisher ultra schlecht gelöst, also qualität hat ultra gelitten.
 *    scheinbar keine automatische planung für code analyse und ernsthafte
 *    überlegung wo errors sein könnten"
 *
 * Phase 1 of the extended bug-fix pipeline. Pure heuristic — returns a
 * confidence between 0..1 + classification. The caller decides
 * based on the threshold (>= 0.6 default) whether the pipeline starts.
 *
 * Difference from `lib/chat/bug-swarm-detection.ts`:
 *   - bug-swarm-detection: binary yes/no for the UI trigger
 *   - bug-detector (here): gradual confidence + bug category
 *     for pipeline decisions + plan-phase inputs.
 *
 * Both detectors exist in parallel — the old one is UI-close and triggers
 * the existing BugFixSwarm; this one is the pipeline-internal
 * confidence layer.
 */

export type BugCategory =
  | 'runtime-error' // TypeError, NPE, etc.
  | 'build-failure' // tsc, next-build, eslint
  | 'test-failure' // failing tests, assertion errors
  | 'http-error' // 5xx/4xx server response
  | 'visual-bug' // UI broken, css overlap
  | 'behavior-bug' // wrong output, missing data
  | 'performance' // slow, hang, OOM
  | 'unknown';

export interface BugIndicators {
  /** 0..1 — how sure that this is a bug report. */
  confidence: number;
  /** Which bug category is most likely. */
  category: BugCategory;
  /** Which signals matched — for audit/debug. */
  signals: ReadonlyArray<string>;
  /** Extracted file:line references (for plan-phase context loading). */
  fileHints: ReadonlyArray<{ file: string; line?: number }>;
  /** Extracted error type names (TypeError, ReferenceError, etc.). */
  errorTypes: ReadonlyArray<string>;
}

/** Score contributions — additive, capped at 1.0. */
const SIGNAL_WEIGHTS = {
  errorTypePattern: 0.45,
  stackTraceLine: 0.4,
  httpErrorCode: 0.35,
  pythonTraceback: 0.4,
  testFailureLine: 0.35,
  buildFailLine: 0.3,
  performanceTerm: 0.25,
  visualBugTerm: 0.2,
  behaviorBugTerm: 0.2,
  bugKeyword: 0.12,
  filePathHint: 0.1,
} as const;

const ERROR_TYPE_RE =
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError|InternalError)\s*:/g;
const STACK_LINE_RE = /\bat\s+[\w.<>$]+\s*\([^)]*:\d+(?::\d+)?\)|\bat\s+[\w./\\-]+:\d+(?::\d+)?\b/;
const HTTP_5XX_RE = /\b(?:5\d\d|4\d\d)\s+(?:Internal Server Error|Bad Request|Not Found|Unauthorized|Forbidden|Service Unavailable|Bad Gateway|Gateway Timeout)/i;
const PY_TRACEBACK_RE = /Traceback\s*\(most recent call last\)/i;
const PY_FILE_LINE_RE = /\bFile\s+"[^"]+",\s+line\s+\d+/;
const TEST_FAIL_RE = /\b(?:expected|received|to equal|to be|assertion|assert\.|toEqual|toBe|expect\()|FAIL\s+[\w./\\-]+\.test\.[tj]sx?/i;
const BUILD_FAIL_RE = /\b(?:tsc|next build|eslint|webpack|vite|esbuild)[^\n]{0,80}(?:error|fail|failed)/i;
const PERF_RE = /\b(slow|hang|hung|freezing|frozen|timeout|OOM|out of memory|exceeded.{0,30}memory|leak)\b/i;
const VISUAL_RE = /\b(overlap|overlapping|cut off|clipped|misaligned|z-index|css.{0,20}broken|layout.{0,20}broken|black screen|white screen)\b/i;
const BEHAVIOR_RE = /\b(wrong|incorrect|missing|empty|nothing happens|does not (work|update|render|show)|nicht.{0,20}(geht|funktioniert|aktualisiert))\b/i;

const BUG_KEYWORDS = [
  'bug',
  'broken',
  'kaputt',
  'fehler',
  'crash',
  'crashed',
  'fail',
  'failed',
  'failure',
  'exception',
  'panic',
  'segfault',
  'undefined is not',
  'cannot read',
  'cannot find',
] as const;

const FILE_LINE_RE = /([\w./\\-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|rb|php|cs|cpp|c|h|hpp))(?::(\d+))?/g;

/**
 * Heuristic with a gradual confidence score + categorization.
 *
 * Thresholds (default):
 *   - confidence >= 0.6 -> start the pipeline
 *   - confidence >= 0.4 && hasFileHint -> start the pipeline (context-triggered)
 *   - otherwise -> don't start
 */
export function detectBugIndicators(input: string): BugIndicators {
  if (typeof input !== 'string') {
    return emptyResult();
  }
  const text = input.trim();
  if (text.length < 12) {
    return emptyResult();
  }

  const signals: string[] = [];
  let score = 0;
  let category: BugCategory = 'unknown';

  // Error-type pattern
  const errorTypes: string[] = [];
  let m: RegExpExecArray | null;
  ERROR_TYPE_RE.lastIndex = 0;
  while ((m = ERROR_TYPE_RE.exec(text)) !== null) {
    errorTypes.push(m[1]!);
  }
  if (errorTypes.length > 0) {
    score += SIGNAL_WEIGHTS.errorTypePattern;
    signals.push('error-type:' + errorTypes.join(','));
    category = 'runtime-error';
  }

  // Stack-trace line
  if (STACK_LINE_RE.test(text)) {
    score += SIGNAL_WEIGHTS.stackTraceLine;
    signals.push('stack-trace');
    if (category === 'unknown') category = 'runtime-error';
  }

  // Python-Traceback
  if (PY_TRACEBACK_RE.test(text) || PY_FILE_LINE_RE.test(text)) {
    score += SIGNAL_WEIGHTS.pythonTraceback;
    signals.push('python-traceback');
    if (category === 'unknown') category = 'runtime-error';
  }

  // HTTP-Error-Code
  if (HTTP_5XX_RE.test(text)) {
    score += SIGNAL_WEIGHTS.httpErrorCode;
    signals.push('http-error');
    if (category === 'unknown') category = 'http-error';
  }

  // Test-Failure
  if (TEST_FAIL_RE.test(text)) {
    score += SIGNAL_WEIGHTS.testFailureLine;
    signals.push('test-failure');
    if (category === 'unknown') category = 'test-failure';
  }

  // Build-Failure
  if (BUILD_FAIL_RE.test(text)) {
    score += SIGNAL_WEIGHTS.buildFailLine;
    signals.push('build-failure');
    if (category === 'unknown') category = 'build-failure';
  }

  // Performance
  if (PERF_RE.test(text)) {
    score += SIGNAL_WEIGHTS.performanceTerm;
    signals.push('performance-term');
    if (category === 'unknown') category = 'performance';
  }

  // Visual
  if (VISUAL_RE.test(text)) {
    score += SIGNAL_WEIGHTS.visualBugTerm;
    signals.push('visual-term');
    if (category === 'unknown') category = 'visual-bug';
  }

  // Behavior
  if (BEHAVIOR_RE.test(text)) {
    score += SIGNAL_WEIGHTS.behaviorBugTerm;
    signals.push('behavior-term');
    if (category === 'unknown') category = 'behavior-bug';
  }

  // Bug keywords (additive, max 3 weights)
  const lower = text.toLowerCase();
  let kwHits = 0;
  for (const kw of BUG_KEYWORDS) {
    if (lower.includes(kw)) {
      kwHits++;
      if (kwHits <= 3) {
        score += SIGNAL_WEIGHTS.bugKeyword;
        signals.push('kw:' + kw);
      }
    }
  }

  // Extract file hints
  const fileHints: Array<{ file: string; line?: number }> = [];
  FILE_LINE_RE.lastIndex = 0;
  const seen = new Set<string>();
  while ((m = FILE_LINE_RE.exec(text)) !== null) {
    const file = m[1]!;
    const line = m[2] ? Number(m[2]) : undefined;
    const key = file + ':' + (line ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    fileHints.push(line !== undefined ? { file, line } : { file });
    if (fileHints.length >= 10) break;
  }
  if (fileHints.length > 0) {
    score += SIGNAL_WEIGHTS.filePathHint;
    signals.push('file-hint:' + fileHints.length);
  }

  // Cap at 1.0
  const confidence = Math.min(1, Number(score.toFixed(3)));

  return {
    confidence,
    category,
    signals,
    fileHints,
    errorTypes,
  };
}

/**
 * Decision helper. Default threshold: 0.6 alone, or 0.4 with a file hint.
 * Callers can override thresholds for tests / tuning.
 */
export function shouldRunPipeline(
  ind: BugIndicators,
  opts?: { minConfidence?: number; minWithFileHint?: number },
): boolean {
  const min = opts?.minConfidence ?? 0.6;
  const minHint = opts?.minWithFileHint ?? 0.4;
  if (ind.confidence >= min) return true;
  if (ind.confidence >= minHint && ind.fileHints.length > 0) return true;
  return false;
}

function emptyResult(): BugIndicators {
  return {
    confidence: 0,
    category: 'unknown',
    signals: [],
    fileHints: [],
    errorTypes: [],
  };
}
