/**
 * lib/agents/pattern-sweep.ts
 * ---------------------------
 * Sprint H+ · 2026-05-03 — Bug-fix pipeline phase 5.5 "Pattern-Sweep + Caller-Graph".
 *
 * User request verbatim (2026-05-03):
 *   „ableitend von Bug — wo könnte sowas noch auftauchen? nachfolgende
 *    Steps werden überlegt ob noch mehr verbuggt sein könnte bevor es
 *    gefixt wird"
 *
 * Task of the phase:
 *   1. Derive a generalized bug pattern from FixPlan + BugIndicators
 *      (property access, call pattern, error type → regex search).
 *   2. Codebase sweep: ripgrep over src/, lib/, app/, server/ (excluding
 *      node_modules, __tests__, dist) for this pattern.
 *   3. Caller graph: for each file in scopeFiles find the importers + callsites
 *      + breakRisk heuristic (high/medium/low).
 *   4. Test coverage: list existing `*.test.ts` next to scopeFiles.
 *   5. Suggested tests: for each patternMatch a pattern test is
 *      suggested if none exists yet.
 *
 * Pure compose logic. Caller injects ALL I/O functions (rgGrep,
 * readFile, fileExists). This makes the file testable without a filesystem.
 *
 * Optional: sub-agent spawn (Haiku, schema-bound) that re-scores the ripgrep raw
 * output into structured match scores. In tests this spawn is
 * mocked — the pure logic without a spawn delivers a deterministic
 * heuristic baseline.
 */

import type { BugIndicators } from './bug-detector';
import type { FixPlan } from './bug-hypothesis';

// ---------- Public Types -----------------------------------------------------

export interface PatternMatch {
  file: string;
  line: number;
  snippet: string;
  /** How similar to the bug pattern: 0..1. */
  similarity: number;
  reason: string;
}

export interface CallerMatch {
  file: string;
  line: number;
  callsite: string;
  /** How likely the caller breaks due to the fix. */
  breakRisk: 'high' | 'medium' | 'low';
}

export interface SuggestedTest {
  testName: string;
  reason: string;
}

export interface SweepResult {
  patternMatches: ReadonlyArray<PatternMatch>;
  callers: ReadonlyArray<CallerMatch>;
  affectedTests: ReadonlyArray<string>;
  suggestedNewTests: ReadonlyArray<SuggestedTest>;
  /** Raw output of all sub-agents/sweep passes for audit. */
  raw: string;
}

export interface PatternSweepInput {
  fixPlan: FixPlan;
  bugIndicators: BugIndicators;
  workspacePath: string;
  workstreamId: string;
}

// ---------- Caller-injected I/O Deps -----------------------------------------

/** A ripgrep match line, normalized. */
export interface GrepHit {
  file: string;
  line: number;
  text: string;
}

export interface PatternSweepDeps {
  /**
   * Ripgrep search in workspacePath. Caller wraps `rg --json` or equivalent.
   * `excludeGlobs` MUST filter at least node_modules/.next/dist for a
   * production caller. `includeDirs` is interpreted relative to workspacePath.
   */
  rgGrep: (input: {
    workspacePath: string;
    pattern: string;
    /** Regex or fixed string. */
    isRegex: boolean;
    includeDirs: ReadonlyArray<string>;
    excludeGlobs: ReadonlyArray<string>;
    maxResults?: number;
  }) => Promise<ReadonlyArray<GrepHit>>;

  /** `import.*from.*<file>` — separate helper so the caller decides the path quote style. */
  rgImporters: (input: {
    workspacePath: string;
    targetFile: string;
    excludeGlobs: ReadonlyArray<string>;
  }) => Promise<ReadonlyArray<GrepHit>>;

  /** Does the file exist (for the test-coverage check)? */
  fileExists: (workspacePath: string, relPath: string) => Promise<boolean>;

  /**
   * Optional: sub-agent re-scoring. If not injected, we use a
   * deterministic heuristic in this file.
   */
  rescoreWithLLM?: (input: {
    fixPlan: FixPlan;
    bugIndicators: BugIndicators;
    rawMatches: ReadonlyArray<GrepHit>;
  }) => Promise<ReadonlyArray<{ file: string; line: number; similarity: number; reason: string }>>;
}

// ---------- Pure Helpers (exported for unit tests) ---------------------------

/**
 * Derive a search pattern (regex) from FixPlan + BugIndicators that
 * finds "similar spots". Strategy:
 *   - errorTypes (TypeError, ReferenceError) → we don't search the error text
 *     itself, but the *code form* that leads to this error.
 *   - "Cannot read properties of undefined" + a property name X → search
 *     `\.X\b` without a preceding null check.
 *   - If we cannot extract a property name, we fall back to
 *     the function name from winningHypothesis.summary.
 *   - Last fallback: keyword-based search for "TODO" + scopeFile base name.
 *
 * The output is a "multi-pattern" — the caller will make two separate rgGrep
 * passes (one for property access, one for function call) and
 * merge the results.
 */
export interface SweepPattern {
  /** Regex (POSIX style, ripgrep-compatible). */
  regex: string;
  /** Reason — reused in PatternMatch.reason. */
  reason: string;
  /** Expected minimum similarity score when a match comes (0..1). */
  baseSimilarity: number;
}

/**
 * Extract: from a string of the form "Cannot read properties of undefined (reading 'foo')"
 * we extract 'foo'. Various variations + fallback to null.
 */
export function extractPropertyName(text: string): string | null {
  if (!text) return null;
  // Modern: "Cannot read properties of undefined (reading 'foo')"
  const modern = /Cannot read propert(?:y|ies) of (?:undefined|null)(?:\s*\(reading\s*['"]([^'"]+)['"]\))?/i.exec(text);
  if (modern && modern[1]) return modern[1];
  // Legacy: "Cannot read property 'foo' of undefined"
  const legacy = /Cannot read property\s*['"]([^'"]+)['"]\s*of\s*(?:undefined|null)/i.exec(text);
  if (legacy && legacy[1]) return legacy[1];
  // Heuristic: ".propertyName is not a function"
  const notFn = /['"]?\.?(\w+)['"]?\s+is not a function/i.exec(text);
  if (notFn && notFn[1]) return notFn[1];
  // Heuristic: "<word> is undefined"
  const isUndef = /\b(\w+)\s+is\s+(?:undefined|not defined)\b/i.exec(text);
  if (isUndef && isUndef[1]) return isUndef[1];
  return null;
}

/**
 * Extract: pull a plausible function name from winningHypothesis.summary
 * (e.g. "AudioPlayer.start crashed when …" → "start").
 */
export function extractFunctionName(text: string): string | null {
  if (!text) return null;
  // "ClassName.method" or "obj.method"
  const m1 = /\b[A-Z]\w*\.(\w+)\b/.exec(text);
  if (m1 && m1[1]) return m1[1];
  // "function calculateTotal …" / "method foo …" / "in xyz(" — parenthesis optional
  const m2 = /\b(?:function|method|fn)\s+(\w+)/.exec(text);
  if (m2 && m2[1]) return m2[1];
  // "in functionName(" — stricter marker
  const m2b = /\bin\s+([a-zA-Z_$]\w+)\s*\(/.exec(text);
  if (m2b && m2b[1]) return m2b[1];
  // Camel-case verb with parenthesis: "advance() throws" → "advance"
  const m3 = /\b([a-z]\w{2,})\s*\(/.exec(text);
  if (m3 && m3[1]) return m3[1];
  return null;
}

/**
 * Build a small list of search patterns from the FixPlan + indicators.
 * We return multiple patterns so the caller can make separate rgGrep passes
 * + merge the results.
 */
export function buildSweepPatterns(
  fixPlan: FixPlan,
  indicators: BugIndicators,
): SweepPattern[] {
  const patterns: SweepPattern[] = [];

  // Property access from error text
  const propName =
    extractPropertyName(fixPlan.winningHypothesis.summary) ||
    extractPropertyName(fixPlan.winningHypothesis.raw) ||
    extractPropertyName(fixPlan.fixApproach);

  if (propName) {
    // `\.foo\b` — all property accesses without a null check before
    patterns.push({
      regex: `\\.${escapeRegex(propName)}\\b`,
      reason: `Gleicher Property-Access wie im Bug: \`.${propName}\``,
      baseSimilarity: 0.6,
    });
  }

  // Function name from the hypothesis summary
  const fnName =
    extractFunctionName(fixPlan.winningHypothesis.summary) ||
    extractFunctionName(fixPlan.fixApproach);
  if (fnName && fnName !== propName) {
    patterns.push({
      regex: `\\b${escapeRegex(fnName)}\\s*\\(`,
      reason: `Gleicher Funktions-Aufruf wie im Bug: \`${fnName}(\``,
      baseSimilarity: 0.4,
    });
  }

  // Error-type-specific (TypeError → unsafe-access pattern)
  for (const et of indicators.errorTypes) {
    if (et === 'TypeError' && propName) {
      // covered by propName-pattern
      continue;
    }
    if (et === 'ReferenceError') {
      patterns.push({
        regex: `\\b(?:typeof\\s+)?[A-Za-z_$][\\w$]*\\s*\\.\\s*[A-Za-z_$]`,
        reason: `${et}-Pattern: ungeschützter Identifier-Access`,
        baseSimilarity: 0.3,
      });
    }
  }

  // Last resort: search for the scopeFile base name as a string reference
  if (patterns.length === 0 && fixPlan.scopeFiles.length > 0) {
    const base = baseName(fixPlan.scopeFiles[0]!.file);
    patterns.push({
      regex: `\\b${escapeRegex(base)}\\b`,
      reason: `Fallback: Referenzen auf ${base}`,
      baseSimilarity: 0.2,
    });
  }

  return patterns;
}

/**
 * Heuristic score: how similar is this hit to the bug pattern.
 * Inputs:
 *  - base score from the pattern (0..1)
 *  - penalty if the hit is in a test or mock file
 *  - penalty if the hit is in a file the fix already touches
 *  - bonus if the hit is at the same directory depth as the scopeFile
 */
export function scoreSimilarity(
  hit: GrepHit,
  pattern: SweepPattern,
  fixPlan: FixPlan,
): number {
  const inScope = fixPlan.scopeFiles.some((s) => s.file === hit.file);
  const lower = hit.file.toLowerCase();
  const isTest =
    lower.includes('__tests__') || lower.includes('.test.') || lower.includes('mock');

  let score = pattern.baseSimilarity;

  // Hard penalty: in scopeFiles → we explicitly search for "other spots", so
  // a scope file should never appear as a pattern match. Penalty large enough
  // that the match falls below the threshold (0.2) even when other bonuses
  // apply.
  if (inScope) {
    score -= 0.7;
  }

  // Penalty: tests/mocks (tests are not a "bug pattern")
  if (isTest) {
    score -= 0.3;
  }

  // Bonus: same top-level directory as the scopeFile — only when
  // the hit is NOT in the scopeFile itself (otherwise double counting).
  if (!inScope && fixPlan.scopeFiles.length > 0) {
    const scopeTop = topDir(fixPlan.scopeFiles[0]!.file);
    const hitTop = topDir(hit.file);
    if (scopeTop && scopeTop === hitTop) score += 0.1;
  }

  // Bonus: snippet contains no `?.` or `??` — i.e. unguarded — only
  // apply when non-scope and non-test (bonuses are noise there).
  if (!inScope && !isTest && !/[?][.]|[?][?]/.test(hit.text)) {
    score += 0.1;
  }

  return clamp01(Number(score.toFixed(3)));
}

/**
 * BreakRisk heuristic for callers. A caller is more likely to break when:
 *   - it uses the symbol multiple times (one spot is probably
 *     covered, many spots = broad API dependency)
 *   - the call lies on a hot path (heuristic: file path contains
 *     `app/api/`, `server/`, `lib/agents/`)
 *   - the call is in a test file → low risk (tests catch it)
 */
export function assessBreakRisk(
  caller: GrepHit,
  importerCount: number,
): 'high' | 'medium' | 'low' {
  const lower = caller.file.toLowerCase();
  if (lower.includes('__tests__') || lower.includes('.test.')) return 'low';

  const inHotPath =
    lower.includes('app/api/') ||
    lower.includes('app\\api\\') ||
    lower.startsWith('server/') ||
    lower.includes('/server/') ||
    lower.includes('lib/agents/');

  if (inHotPath || importerCount >= 5) return 'high';
  if (importerCount >= 2) return 'medium';
  return 'low';
}

// ---------- Main Compose-Function -------------------------------------------

const DEFAULT_INCLUDE = ['lib', 'app', 'server', 'src'] as const;
const DEFAULT_EXCLUDE = [
  'node_modules',
  '.next',
  'dist',
  'build',
  '__tests__',
  '*.test.ts',
  '*.test.tsx',
] as const;

export async function runPatternSweepImpl(
  deps: PatternSweepDeps,
  input: PatternSweepInput,
): Promise<SweepResult> {
  const { fixPlan, bugIndicators, workspacePath } = input;

  // Step 1: pattern extraction
  const patterns = buildSweepPatterns(fixPlan, bugIndicators);

  // Step 2: codebase sweep — one rgGrep pass per pattern
  const rawAggregate: GrepHit[] = [];
  const matchByKey = new Map<string, PatternMatch>();
  for (const p of patterns) {
    let hits: ReadonlyArray<GrepHit> = [];
    try {
      hits = await deps.rgGrep({
        workspacePath,
        pattern: p.regex,
        isRegex: true,
        includeDirs: [...DEFAULT_INCLUDE],
        excludeGlobs: [...DEFAULT_EXCLUDE],
        maxResults: 30,
      });
    } catch {
      // Sweep-pass failure → skip the pattern, don't abort
      hits = [];
    }
    for (const h of hits) {
      rawAggregate.push(h);
      const sim = scoreSimilarity(h, p, fixPlan);
      // Keep only matches with similarity >= 0.2 — the rest is noise
      if (sim < 0.2) continue;
      const key = `${h.file}:${h.line}`;
      const existing = matchByKey.get(key);
      if (!existing || existing.similarity < sim) {
        matchByKey.set(key, {
          file: h.file,
          line: h.line,
          snippet: trimSnippet(h.text),
          similarity: sim,
          reason: p.reason,
        });
      }
    }
  }

  // Step 2b: optional sub-agent re-scoring
  if (deps.rescoreWithLLM && rawAggregate.length > 0) {
    try {
      const rescored = await deps.rescoreWithLLM({
        fixPlan,
        bugIndicators,
        rawMatches: rawAggregate.slice(0, 30),
      });
      for (const r of rescored) {
        const key = `${r.file}:${r.line}`;
        const existing = matchByKey.get(key);
        if (existing) {
          // Merge: LLM score wins if higher
          if (r.similarity > existing.similarity) {
            matchByKey.set(key, {
              ...existing,
              similarity: clamp01(r.similarity),
              reason: r.reason || existing.reason,
            });
          }
        }
      }
    } catch {
      // An LLM failure is not a pipeline block — the heuristic baseline suffices.
    }
  }

  const patternMatches = Array.from(matchByKey.values()).sort(
    (a, b) => b.similarity - a.similarity,
  );

  // Step 3: caller graph
  const callers: CallerMatch[] = [];
  const importerByFile = new Map<string, number>();
  for (const scopeFile of fixPlan.scopeFiles) {
    let importers: ReadonlyArray<GrepHit> = [];
    try {
      importers = await deps.rgImporters({
        workspacePath,
        targetFile: scopeFile.file,
        excludeGlobs: [...DEFAULT_EXCLUDE],
      });
    } catch {
      importers = [];
    }
    importerByFile.set(scopeFile.file, importers.length);
    for (const imp of importers) {
      callers.push({
        file: imp.file,
        line: imp.line,
        callsite: trimSnippet(imp.text),
        breakRisk: assessBreakRisk(imp, importers.length),
      });
    }
  }

  // Caller dedupe (file+line uniq) + risk sort high>medium>low
  const dedupedCallers = dedupeCallers(callers);

  // Step 4: test coverage
  const affectedTests: string[] = [];
  for (const scopeFile of fixPlan.scopeFiles) {
    const candidates = testCandidates(scopeFile.file);
    for (const c of candidates) {
      try {
        const exists = await deps.fileExists(workspacePath, c);
        if (exists && !affectedTests.includes(c)) affectedTests.push(c);
      } catch {
        // skip
      }
    }
  }

  // Step 5: suggested tests — one pattern test per patternMatch (with
  // similarity >= 0.5) when the match file has no test yet
  const suggestedNewTests: SuggestedTest[] = [];
  const seenSuggest = new Set<string>();
  for (const m of patternMatches) {
    if (m.similarity < 0.5) continue;
    const candidates = testCandidates(m.file);
    let covered = false;
    for (const c of candidates) {
      try {
        if (await deps.fileExists(workspacePath, c)) {
          covered = true;
          break;
        }
      } catch {
        // skip
      }
    }
    if (covered) continue;
    const testName = `${baseName(m.file)} — Pattern-Regression: ${m.reason}`;
    if (seenSuggest.has(testName)) continue;
    seenSuggest.add(testName);
    suggestedNewTests.push({
      testName,
      reason: `Match in ${m.file}:${m.line} (Similarity ${m.similarity.toFixed(2)}) hat keinen Test — Pattern könnte unbemerkt bleiben.`,
    });
  }

  const raw =
    `pattern-sweep · patterns=${patterns.length} ` +
    `rawHits=${rawAggregate.length} ` +
    `keptMatches=${patternMatches.length} ` +
    `callers=${dedupedCallers.length} ` +
    `affectedTests=${affectedTests.length} ` +
    `suggestedTests=${suggestedNewTests.length}`;

  return {
    patternMatches,
    callers: dedupedCallers,
    affectedTests,
    suggestedNewTests,
    raw,
  };
}

// ---------- Internal Helpers -------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function baseName(file: string): string {
  const noQuery = file.split('?')[0]!;
  const seg = noQuery.split(/[\\/]/);
  const last = seg[seg.length - 1] ?? noQuery;
  return last.replace(/\.[^.]+$/, '');
}

function topDir(file: string): string | null {
  const seg = file.split(/[\\/]/);
  return seg.length > 1 ? seg[0]! : null;
}

function trimSnippet(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 200) return trimmed;
  return trimmed.slice(0, 199) + '…';
}

function testCandidates(file: string): string[] {
  // We search `<file>.test.ts` and `__tests__/<basename>.test.ts`
  const m = /^(.*?)([^/\\]+)\.(ts|tsx|js|jsx)$/.exec(file);
  if (!m) return [];
  const [, dir, name, ext] = m;
  const candidates: string[] = [];
  candidates.push(`${dir}${name}.test.${ext}`);
  candidates.push(`${dir}__tests__/${name}.test.${ext}`);
  // Edge: for tsx also .test.ts (common pattern)
  if (ext === 'tsx') {
    candidates.push(`${dir}${name}.test.ts`);
    candidates.push(`${dir}__tests__/${name}.test.ts`);
  }
  return candidates;
}

function dedupeCallers(callers: ReadonlyArray<CallerMatch>): CallerMatch[] {
  const order: Record<CallerMatch['breakRisk'], number> = {
    high: 3,
    medium: 2,
    low: 1,
  };
  const seen = new Map<string, CallerMatch>();
  for (const c of callers) {
    const key = `${c.file}:${c.line}`;
    const existing = seen.get(key);
    if (!existing || order[c.breakRisk] > order[existing.breakRisk]) {
      seen.set(key, c);
    }
  }
  return Array.from(seen.values()).sort(
    (a, b) => order[b.breakRisk] - order[a.breakRisk],
  );
}
