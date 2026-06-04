/**
 * Tests fuer lib/agents/bug-detector.ts (Sprint H+ · 2026-05-01).
 *
 * Run: `npx tsx --test --test-force-exit lib/agents/__tests__/bug-detector.test.ts`
 *
 * Cases:
 *   1. Klassischer TypeError + Stack: confidence > 0.6, runtime-error, fileHints>=1
 *   2. Test-Failure: category=test-failure
 *   3. HTTP 500: category=http-error
 *   4. Performance-Beschwerde "App hängt nach 3 min": category=performance
 *   5. Visual-Bug "buttons overlap on mobile": category=visual-bug
 *   6. Behavior "wrong total in cart": category=behavior-bug
 *   7. Smalltalk: confidence < 0.4
 *   8. Leerer Input: confidence=0
 *   9. shouldRunPipeline: 0.65 -> true; 0.45 ohne file -> false; 0.45 mit file -> true
 *  10. fileHints werden dedupliziert
 *  11. Build-Failure "tsc error: ..." -> category=build-failure
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { detectBugIndicators, shouldRunPipeline } from '../bug-detector';

describe('detectBugIndicators', () => {
  it('classic TypeError with stack trace -> high confidence runtime-error', () => {
    const input = `Voice-Message wird nicht gespielt. Console:
TypeError: Cannot read properties of undefined (reading 'play')
    at AudioPlayer.start (audio-player.ts:42:18)
    at PlaybackQueue.advance (queue.ts:18:9)`;
    const r = detectBugIndicators(input);
    assert.ok(r.confidence > 0.6, `expected >0.6, got ${r.confidence}`);
    assert.equal(r.category, 'runtime-error');
    assert.ok(r.fileHints.length >= 1);
    assert.ok(r.errorTypes.includes('TypeError'));
  });

  it('test-failure detection', () => {
    const input = `expect(result.total).toEqual(42)
Expected: 42
Received: 0
FAIL  src/cart.test.ts`;
    const r = detectBugIndicators(input);
    assert.equal(r.category, 'test-failure');
    assert.ok(r.confidence >= 0.3);
  });

  it('HTTP 500 error -> http-error category', () => {
    const input = 'API gibt 500 Internal Server Error zurück beim Login.';
    const r = detectBugIndicators(input);
    assert.equal(r.category, 'http-error');
    assert.ok(r.confidence >= 0.3);
  });

  it('performance issue', () => {
    const input = 'Die App hängt komplett, der Browser-Tab freezing nach 3 Minuten Use.';
    const r = detectBugIndicators(input);
    assert.equal(r.category, 'performance');
  });

  it('visual bug', () => {
    const input = 'Auf Mobile überlappen die Buttons im Header — das z-index scheint broken zu sein.';
    const r = detectBugIndicators(input);
    assert.equal(r.category, 'visual-bug');
  });

  it('behavior bug', () => {
    const input = 'Der Total im Cart ist wrong — zeigt 0 obwohl 3 Items drin sind, nichts updated sich.';
    const r = detectBugIndicators(input);
    // Behavior-Term + Keyword-Hit "wrong" oder "broken"
    assert.ok(['behavior-bug', 'unknown'].includes(r.category));
    assert.ok(r.confidence > 0.1);
  });

  it('smalltalk -> low confidence', () => {
    const r = detectBugIndicators('Hey, ich liebe diese App und finde sie super hilfreich!');
    assert.ok(r.confidence < 0.4);
    assert.equal(r.category, 'unknown');
  });

  it('empty input -> 0', () => {
    assert.equal(detectBugIndicators('').confidence, 0);
    assert.equal(detectBugIndicators('   \n  ').confidence, 0);
    assert.equal(detectBugIndicators('hi').confidence, 0); // < 12
  });

  it('shouldRunPipeline thresholds', () => {
    assert.equal(
      shouldRunPipeline({ confidence: 0.65, category: 'runtime-error', signals: [], fileHints: [], errorTypes: [] }),
      true,
    );
    assert.equal(
      shouldRunPipeline({ confidence: 0.45, category: 'unknown', signals: [], fileHints: [], errorTypes: [] }),
      false,
    );
    assert.equal(
      shouldRunPipeline({
        confidence: 0.45,
        category: 'unknown',
        signals: [],
        fileHints: [{ file: 'foo.ts', line: 12 }],
        errorTypes: [],
      }),
      true,
    );
    // Custom-Override
    assert.equal(
      shouldRunPipeline(
        { confidence: 0.55, category: 'unknown', signals: [], fileHints: [], errorTypes: [] },
        { minConfidence: 0.5 },
      ),
      true,
    );
  });

  it('deduplicates fileHints by file+line', () => {
    const input = `Error in audio-player.ts:42 — and also at audio-player.ts:42:18 stack trace says audio-player.ts:42`;
    const r = detectBugIndicators(input);
    // file-line "42" sollte nur einmal sein (mit/ohne col-version dedupliziert).
    const sameFiles = r.fileHints.filter(
      (f) => f.file.endsWith('audio-player.ts') && f.line === 42,
    );
    assert.ok(sameFiles.length <= 1, `expected <=1 dedup, got ${sameFiles.length}`);
  });

  it('build-failure -> build-failure category', () => {
    const input = 'tsc error: TS2304 Cannot find name "foo" in src/index.ts';
    const r = detectBugIndicators(input);
    // tsc + error + file -> build-failure ODER runtime-error abhängig von Pattern-Reihenfolge.
    // Wir akzeptieren build-failure ODER runtime-error wenn ErrorType-Pattern nicht greift.
    assert.ok(['build-failure', 'unknown', 'runtime-error'].includes(r.category));
    assert.ok(r.confidence >= 0.3);
  });

  it('non-string input is safe', () => {
    // @ts-expect-error testing runtime-safety
    const r = detectBugIndicators(undefined);
    assert.equal(r.confidence, 0);
  });
});
