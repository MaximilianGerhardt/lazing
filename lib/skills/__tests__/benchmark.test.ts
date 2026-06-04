/**
 * lib/skills/__tests__/benchmark.test.ts — pure Teile des Skill-Benchmarks.
 * (Der orchestrate-Runner ist Integration; hier: Grader + Aggregation.)
 */
import { describe, expect, it } from 'vitest';

import { aggregateVariant, buildScorecard, gradeOutput } from '../benchmark';

describe('gradeOutput', () => {
  it('contains / notContains / matches (case-insensitiv)', () => {
    const out = 'Nutze `lazyos-cli cloud generate` und füge die surface:document-Zeile ein.';
    expect(gradeOutput(out, [{ contains: 'cloud generate' }, { contains: 'surface:document' }])).toEqual({
      passed: 2,
      total: 2,
      ok: true,
    });
    expect(gradeOutput(out, [{ notContains: 'pptx' }]).ok).toBe(true);
    expect(gradeOutput(out, [{ matches: 'cloud\\s+generate' }]).ok).toBe(true);
    expect(gradeOutput('nichts passendes', [{ contains: 'xlsx' }]).ok).toBe(false);
  });

  it('kaputtes Regex → Assertion failt (kein Crash)', () => {
    expect(gradeOutput('x', [{ matches: '(' }]).passed).toBe(0);
  });
});

describe('aggregateVariant', () => {
  it('Pass-Rate + Assertion-Rate + mean Latenz', () => {
    const stats = aggregateVariant([
      { passed: 2, total: 2, ok: true, latencyMs: 100 },
      { passed: 1, total: 2, ok: false, latencyMs: 300 },
    ]);
    expect(stats.passRate).toBe(0.5);
    expect(stats.assertionRate).toBe(0.75);
    expect(stats.meanLatencyMs).toBe(200);
    expect(stats.tasks).toBe(2);
  });

  it('leer → Nullen', () => {
    expect(aggregateVariant([])).toEqual({ passRate: 0, assertionRate: 0, meanLatencyMs: 0, tasks: 0 });
  });
});

describe('buildScorecard', () => {
  it('Delta = withSkill − baseline (Skill hilft → positiv)', () => {
    const card = buildScorecard(
      'doc',
      [
        { passed: 0, total: 2, ok: false, latencyMs: 100 },
        { passed: 1, total: 2, ok: false, latencyMs: 100 },
      ],
      [
        { passed: 2, total: 2, ok: true, latencyMs: 120 },
        { passed: 2, total: 2, ok: true, latencyMs: 120 },
      ],
    );
    expect(card.baseline.passRate).toBe(0);
    expect(card.withSkill.passRate).toBe(1);
    expect(card.passRateDelta).toBe(1);
    expect(card.assertionRateDelta).toBeGreaterThan(0);
  });
});
