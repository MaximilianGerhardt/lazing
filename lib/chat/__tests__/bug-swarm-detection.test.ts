/**
 * Tests für `detectBugReport` (Sprint H · 2026-04-30).
 * Pure-Funktion → reine Vitest-Cases, kein Mocking nötig.
 *
 * Cases (verbatim aus Sprint-H-Briefing):
 *   1. Klarer Error-Report (TypeError + Stack)         -> isBug=true
 *   2. Smalltalk ("I love this app")                    -> isBug=false
 *   3. /no-swarm-Bypass am Anfang                       -> isBug=false, cleaned ohne Marker
 *   4. Leerer Text                                      -> isBug=false
 *   5. Reine stack-trace (kein Keyword)                 -> isBug=true (Pattern reicht)
 *   6. 2 Keywords ohne Pattern                          -> isBug=true
 *   7. 1 Keyword (zu wenig Substanz)                    -> isBug=false
 *   8. /no-swarmething (kein Bypass — Prefix-Trick)     -> normaler Detection-Pfad
 */

import { describe, it, expect } from 'vitest';

import { detectBugReport } from '../bug-swarm-detection';

describe('detectBugReport', () => {
  it('detects classic TypeError report with stack trace', () => {
    const input = `Voice-Message wird nicht gespielt. Console:
TypeError: Cannot read properties of undefined (reading 'play')
    at AudioPlayer.start (audio-player.ts:42:18)
    at PlaybackQueue.advance (queue.ts:18:9)`;
    const result = detectBugReport(input);
    expect(result.isBug).toBe(true);
    expect(result.bypassedByUser).toBe(false);
    expect(result.matchedSignals.length).toBeGreaterThan(0);
    // mindestens 1 Pattern-Match (TypeError ODER stack-line)
    expect(result.matchedSignals.some((s) => s.startsWith('pat:'))).toBe(true);
  });

  it('does not flag smalltalk', () => {
    const result = detectBugReport(
      'Hey, ich liebe diese App und finde sie super hilfreich für mein Projekt!',
    );
    expect(result.isBug).toBe(false);
    expect(result.bypassedByUser).toBe(false);
    expect(result.matchedSignals).toHaveLength(0);
  });

  it('honors /no-swarm bypass and strips the prefix', () => {
    const input =
      '/no-swarm Hier ist ein Error: ich will NICHT dass der Swarm aktiviert wird.';
    const result = detectBugReport(input);
    expect(result.isBug).toBe(false);
    expect(result.bypassedByUser).toBe(true);
    expect(result.cleanedMessage).toBe(
      'Hier ist ein Error: ich will NICHT dass der Swarm aktiviert wird.',
    );
  });

  it('returns false for empty input', () => {
    expect(detectBugReport('').isBug).toBe(false);
    expect(detectBugReport('   \n  ').isBug).toBe(false);
    expect(detectBugReport('error').isBug).toBe(false); // < 20 chars
  });

  it('triggers on stack-trace pattern alone (no keyword)', () => {
    const input =
      'Schau mal:    at parseModule (module-loader.ts:128:14)    at compile (compiler.ts:42:8)';
    const result = detectBugReport(input);
    expect(result.isBug).toBe(true);
    expect(result.matchedSignals.some((s) => s.startsWith('pat:'))).toBe(true);
  });

  it('triggers on >=2 keywords even without a pattern', () => {
    const input =
      'Der Build ist komplett broken und crashed sofort beim Starten — was tun?';
    const result = detectBugReport(input);
    expect(result.isBug).toBe(true);
    expect(
      result.matchedSignals.filter((s) => s.startsWith('kw:')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('does not trigger on single weak keyword without context', () => {
    // "error" einzeln in einem Smalltalk-Satz darf NICHT triggern.
    const input =
      'I think there might be an error in my reasoning, but generally things are fine here.';
    const result = detectBugReport(input);
    // Genau 1 Keyword ("error") und kein Pattern → isBug=false.
    const kwCount = result.matchedSignals.filter((s) =>
      s.startsWith('kw:'),
    ).length;
    expect(kwCount).toBe(1);
    expect(result.isBug).toBe(false);
  });

  it('does NOT match /no-swarmething as bypass (prefix-attack)', () => {
    const input = '/no-swarmething here we go with random text content yeah';
    const result = detectBugReport(input);
    // Bypass darf NICHT greifen — fortgesetzte Buchstaben statt Whitespace.
    expect(result.bypassedByUser).toBe(false);
    // Cleaned-Message bleibt unverändert.
    expect(result.cleanedMessage).toBe(input);
  });
});
