/**
 * Tests fuer lib/agents/pattern-sweep.ts (Sprint H+ · 2026-05-03).
 *
 * Run: `pnpm exec vitest run lib/agents/__tests__/pattern-sweep.test.ts`
 *
 * Cases:
 *   1. extractPropertyName: alle Variationen
 *   2. extractFunctionName: Class.method + function-name patterns
 *   3. buildSweepPatterns: TypeError + Property → propertyName-Pattern
 *   4. buildSweepPatterns: kein Property → Funktionsname-Pattern
 *   5. buildSweepPatterns: leerer Plan → Fallback auf scopeFile-Basename
 *   6. scoreSimilarity: scopeFile-Hit → niedrige Similarity (Penalty)
 *   7. scoreSimilarity: Test-File-Hit → Penalty
 *   8. scoreSimilarity: gleiches Top-Dir → Bonus
 *   9. assessBreakRisk: Hot-Path → high
 *  10. assessBreakRisk: Test-Datei → low
 *  11. runPatternSweepImpl: Happy-Path mit gemockten rgGrep + rgImporters
 *  12. runPatternSweepImpl: rgGrep-Failure überspringt Pattern, Pipeline läuft weiter
 *  13. runPatternSweepImpl: scopeFile-Hits werden NICHT als patternMatches geliefert
 *  14. runPatternSweepImpl: affectedTests gefunden, suggestedNewTests = 0
 *  15. runPatternSweepImpl: rescoreWithLLM-Override hebt Similarity
 */

import { describe, it, expect } from 'vitest';

import type { BugIndicators } from '../bug-detector';
import type { FixPlan, Hypothesis } from '../bug-hypothesis';
import {
  assessBreakRisk,
  buildSweepPatterns,
  extractFunctionName,
  extractPropertyName,
  runPatternSweepImpl,
  scoreSimilarity,
  type GrepHit,
  type PatternSweepDeps,
  type SweepPattern,
} from '../pattern-sweep';

// ---------- Fixtures --------------------------------------------------------

function mkHyp(p: Partial<Hypothesis>): Hypothesis {
  return {
    perspective: 'syntactic-perspective',
    summary: 'AudioPlayer.start crashed when playback queue was empty',
    files: [{ file: 'lib/audio/audio-player.ts', line: 42 }],
    confidence: 0.7,
    raw: 'TypeError: Cannot read properties of undefined (reading \'start\')',
    ...p,
  };
}

function mkPlan(p: Partial<FixPlan> = {}): FixPlan {
  return {
    winningHypothesis: mkHyp({}),
    rankedHypotheses: [{ hyp: mkHyp({}), score: 0.7 }],
    fixApproach: 'Guard for undefined before calling .start',
    scopeFiles: [{ file: 'lib/audio/audio-player.ts', line: 42 }],
    planQuality: 'strong',
    ...p,
  };
}

function mkIndicators(p: Partial<BugIndicators> = {}): BugIndicators {
  return {
    confidence: 0.85,
    category: 'runtime-error',
    signals: ['error-type:TypeError'],
    fileHints: [{ file: 'lib/audio/audio-player.ts', line: 42 }],
    errorTypes: ['TypeError'],
    ...p,
  };
}

// ---------- Pure-Helper Tests -----------------------------------------------

describe('extractPropertyName', () => {
  it('matches modern format', () => {
    expect(
      extractPropertyName("Cannot read properties of undefined (reading 'start')"),
    ).toBe('start');
  });
  it('matches legacy format', () => {
    expect(
      extractPropertyName("Cannot read property 'foo' of undefined"),
    ).toBe('foo');
  });
  it('matches "is not a function"', () => {
    expect(extractPropertyName('foo.bar is not a function')).toBe('bar');
  });
  it('returns null for irrelevant text', () => {
    expect(extractPropertyName('hello world')).toBe(null);
  });
  it('handles empty input', () => {
    expect(extractPropertyName('')).toBe(null);
  });
});

describe('extractFunctionName', () => {
  it('extracts Class.method', () => {
    expect(extractFunctionName('AudioPlayer.start crashed')).toBe('start');
  });
  it('extracts function call form', () => {
    expect(extractFunctionName('the function advance() throws')).toBe('advance');
  });
  it('returns null for noise', () => {
    expect(extractFunctionName('xyz')).toBe(null);
  });
});

describe('buildSweepPatterns', () => {
  it('returns property-access pattern from TypeError + summary', () => {
    const patterns = buildSweepPatterns(mkPlan(), mkIndicators());
    expect(patterns.length >= 1).toBeTruthy();
    const propPat = patterns.find((p) => p.regex.includes('start'));
    expect(propPat).toBeTruthy(); // expected pattern referencing .start
    expect(propPat!.regex).toMatch(/\\\.start/);
    expect(propPat!.baseSimilarity > 0.5).toBeTruthy();
  });

  it('falls back to function-name when no property is detectable', () => {
    const plan = mkPlan({
      winningHypothesis: mkHyp({
        summary: 'function calculateTotal returns wrong value when discount is applied',
        raw: 'wrong amount',
      }),
      fixApproach: 'fix calculateTotal',
    });
    const patterns = buildSweepPatterns(plan, mkIndicators({ errorTypes: [] }));
    expect(patterns.length >= 1).toBeTruthy();
    expect(patterns.some((p) => p.regex.includes('calculateTotal'))).toBeTruthy();
  });

  it('falls back to scopeFile basename when nothing else matches', () => {
    const plan = mkPlan({
      winningHypothesis: mkHyp({
        summary: 'xyz',
        raw: '',
      }),
      fixApproach: '',
      scopeFiles: [{ file: 'lib/utils/helper.ts' }],
    });
    const patterns = buildSweepPatterns(
      plan,
      mkIndicators({ errorTypes: [], category: 'unknown' }),
    );
    expect(patterns.length >= 1).toBeTruthy();
    expect(patterns.some((p) => p.regex.includes('helper'))).toBeTruthy();
  });
});

describe('scoreSimilarity', () => {
  const pattern: SweepPattern = {
    regex: '\\.start\\b',
    reason: 'same property access',
    baseSimilarity: 0.6,
  };

  it('penalizes hits inside scopeFiles', () => {
    const hit: GrepHit = {
      file: 'lib/audio/audio-player.ts',
      line: 50,
      text: 'this.player.start()',
    };
    const score = scoreSimilarity(hit, pattern, mkPlan());
    expect(score < 0.3).toBeTruthy(); // expected low score (in scope), got ${score}
  });

  it('penalizes hits in test files', () => {
    const hit: GrepHit = {
      file: 'lib/foo/__tests__/foo.test.ts',
      line: 10,
      text: 'foo.start()',
    };
    const score = scoreSimilarity(hit, pattern, mkPlan());
    expect(score < pattern.baseSimilarity).toBeTruthy();
  });

  it('rewards hits in same top-dir as scope', () => {
    const inSameTop: GrepHit = {
      file: 'lib/somewhere/else.ts',
      line: 1,
      text: 'obj.start()',
    };
    const inOtherTop: GrepHit = {
      file: 'app/page.tsx',
      line: 1,
      text: 'obj.start()',
    };
    const a = scoreSimilarity(inSameTop, pattern, mkPlan());
    const b = scoreSimilarity(inOtherTop, pattern, mkPlan());
    expect(a > b).toBeTruthy(); // expected ${a} > ${b}
  });
});

describe('assessBreakRisk', () => {
  it('hot-path -> high', () => {
    const hit: GrepHit = { file: 'app/api/foo/route.ts', line: 1, text: 'x' };
    expect(assessBreakRisk(hit, 1)).toBe('high');
  });
  it('test file -> low', () => {
    const hit: GrepHit = { file: 'lib/foo/__tests__/foo.test.ts', line: 1, text: 'x' };
    expect(assessBreakRisk(hit, 10)).toBe('low');
  });
  it('many importers -> high', () => {
    const hit: GrepHit = { file: 'lib/util.ts', line: 1, text: 'x' };
    expect(assessBreakRisk(hit, 5)).toBe('high');
  });
  it('few importers, normal path -> medium or low', () => {
    const hit: GrepHit = { file: 'components/widget.tsx', line: 1, text: 'x' };
    expect(assessBreakRisk(hit, 1)).toBe('low');
    expect(assessBreakRisk(hit, 2)).toBe('medium');
  });
});

// ---------- runPatternSweepImpl Tests ---------------------------------------

interface MockGrepCalls {
  grepCalls: number;
  importerCalls: number;
  fileExistsChecks: string[];
}

function mkMockDeps(
  hits: ReadonlyArray<GrepHit>,
  importers: ReadonlyArray<GrepHit>,
  existingFiles: ReadonlyArray<string>,
  shouldThrowGrep = false,
): { deps: PatternSweepDeps; calls: MockGrepCalls } {
  const calls: MockGrepCalls = {
    grepCalls: 0,
    importerCalls: 0,
    fileExistsChecks: [],
  };
  const deps: PatternSweepDeps = {
    rgGrep: async () => {
      calls.grepCalls++;
      if (shouldThrowGrep) throw new Error('rg crashed');
      return hits;
    },
    rgImporters: async () => {
      calls.importerCalls++;
      return importers;
    },
    fileExists: async (_w, p) => {
      calls.fileExistsChecks.push(p);
      return existingFiles.includes(p);
    },
  };
  return { deps, calls };
}

describe('runPatternSweepImpl', () => {
  it('happy path: produces matches, callers, tests, suggestions', async () => {
    const hits: GrepHit[] = [
      // OUTSIDE scope, same top-dir → should pass
      { file: 'lib/playback/queue.ts', line: 18, text: 'queue.start()' },
      // IN scope → should be filtered (penalty drops below threshold)
      { file: 'lib/audio/audio-player.ts', line: 99, text: 'this.start()' },
      // TEST file → penalty
      {
        file: 'lib/__tests__/audio.test.ts',
        line: 5,
        text: 'p.start()',
      },
    ];
    const importers: GrepHit[] = [
      {
        file: 'app/api/play/route.ts',
        line: 3,
        text: 'import { AudioPlayer } from "../../../lib/audio/audio-player"',
      },
    ];
    const { deps, calls } = mkMockDeps(hits, importers, [
      // queue.ts has NO test (suggested-new-test should be created)
      // audio-player has a test
      'lib/audio/__tests__/audio-player.test.ts',
    ]);

    const result = await runPatternSweepImpl(deps, {
      fixPlan: mkPlan(),
      bugIndicators: mkIndicators(),
      workspacePath: '/tmp/ws',
      workstreamId: 'WS-1',
    });

    expect(calls.grepCalls >= 1).toBeTruthy();
    expect(calls.importerCalls >= 1).toBeTruthy();
    // queue.ts ist OUTSIDE scope und hat hohe Similarity → muss in matches sein
    expect(
      result.patternMatches.some((m) => m.file === 'lib/playback/queue.ts'),
    ).toBeTruthy();
    // audio-player.ts IN scope → niedrige Similarity (Penalty)
    expect(
      !result.patternMatches.some(
        (m) => m.file === 'lib/audio/audio-player.ts' && m.similarity > 0.3,
      ),
    ).toBeTruthy();
    // Caller-Graph
    expect(result.callers.length).toBe(1);
    expect(result.callers[0]!.file).toBe('app/api/play/route.ts');
    expect(result.callers[0]!.breakRisk).toBe('high'); // hot-path
    // Test-Coverage
    expect(result.affectedTests.includes('lib/audio/__tests__/audio-player.test.ts')).toBeTruthy();
    // Suggested-Tests: queue.ts hat keinen Test
    expect(result.suggestedNewTests.length >= 1).toBeTruthy();
    expect(result.suggestedNewTests.some((s) => s.testName.includes('queue'))).toBeTruthy();
  });

  it('rgGrep throwing does not crash sweep', async () => {
    const { deps } = mkMockDeps([], [], [], true);
    const result = await runPatternSweepImpl(deps, {
      fixPlan: mkPlan(),
      bugIndicators: mkIndicators(),
      workspacePath: '/tmp/ws',
      workstreamId: 'WS-1',
    });
    expect(result.patternMatches.length).toBe(0);
    // Sweep liefert trotzdem Result
    expect(result.raw).toMatch(/pattern-sweep/);
  });

  it('rescoreWithLLM raises similarity', async () => {
    const hits: GrepHit[] = [
      { file: 'lib/elsewhere/thing.ts', line: 22, text: 'obj.start()' },
    ];
    const baseDeps = mkMockDeps(hits, [], []).deps;
    const deps: PatternSweepDeps = {
      ...baseDeps,
      rescoreWithLLM: async () => [
        {
          file: 'lib/elsewhere/thing.ts',
          line: 22,
          similarity: 0.95,
          reason: 'LLM-augmented: identical unguarded access',
        },
      ],
    };
    const result = await runPatternSweepImpl(deps, {
      fixPlan: mkPlan(),
      bugIndicators: mkIndicators(),
      workspacePath: '/tmp/ws',
      workstreamId: 'WS-1',
    });
    const m = result.patternMatches.find((x) => x.file === 'lib/elsewhere/thing.ts');
    expect(m).toBeTruthy();
    expect(m!.similarity).toBe(0.95);
    expect(m!.reason).toMatch(/LLM-augmented/);
  });

  it('no patterns extractable (very thin plan) -> empty result, no crash', async () => {
    const thinPlan = mkPlan({
      winningHypothesis: mkHyp({
        summary: 'x',
        raw: '',
        files: [],
      }),
      fixApproach: '',
      scopeFiles: [],
    });
    const { deps } = mkMockDeps([], [], []);
    const result = await runPatternSweepImpl(deps, {
      fixPlan: thinPlan,
      bugIndicators: mkIndicators({ errorTypes: [], category: 'unknown' }),
      workspacePath: '/tmp/ws',
      workstreamId: 'WS-1',
    });
    expect(result.patternMatches.length).toBe(0);
    expect(result.callers.length).toBe(0);
    expect(result.suggestedNewTests.length).toBe(0);
  });

  it('scope-file matches are filtered out via similarity threshold', async () => {
    // Hit liegt EXAKT im scopeFile → Penalty -0.5 → (0.6 - 0.5) = 0.1 < 0.2 → kein Match
    const hits: GrepHit[] = [
      { file: 'lib/audio/audio-player.ts', line: 1, text: '.start()' },
    ];
    const { deps } = mkMockDeps(hits, [], []);
    const result = await runPatternSweepImpl(deps, {
      fixPlan: mkPlan(),
      bugIndicators: mkIndicators(),
      workspacePath: '/tmp/ws',
      workstreamId: 'WS-1',
    });
    expect(result.patternMatches.length).toBe(0);
  });
});
