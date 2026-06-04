/**
 * lib/flow/__tests__/param-heuristic.test.ts — Auto-Param 2b-4 (pure).
 *
 * Deterministische 1-Lauf-Heuristik: Feldname- ODER Wert-Form schlägt Parameter
 * vor; Marke/Stil/Engine-Felder sind ausgeschlossen; Keys deterministisch +
 * kollisionsfrei (identisch zur diffRuns-Ableitung).
 */

import { describe, expect, it } from 'vitest';

import { suggestParamsFromSingleRun } from '@/lib/flow/param-heuristic';
import type { StepRunConfig } from '@/lib/flow/param-diff';

describe('suggestParamsFromSingleRun', () => {
  it('Name-Hint trifft (topic/query), Marke bleibt aussen vor (brand_voice)', () => {
    const run: StepRunConfig[] = [
      { label: 'researcher', values: { query: 'Solar' } },
      { label: 'script', values: { topic: 'Solar', brand_voice: 'laz.ing' } },
    ];
    const params = suggestParamsFromSingleRun(run);
    const fields = params.map((p) => p.field).sort();
    expect(fields).toEqual(['query', 'topic']); // brand_voice ausgeschlossen
    // observed = der eine beobachtete Wert (verbatim).
    expect(params.find((p) => p.field === 'topic')?.observed).toEqual(['Solar']);
  });

  it('Wert-Form trifft auch bei neutralem Feldnamen (URL, Datum, freier Text)', () => {
    const run: StepRunConfig[] = [
      {
        label: 'step',
        values: {
          ref: 'https://example.com/post/123',
          when: '2026-06-04',
          blurb: 'Ein laengerer Satz der wie ein Topic klingt und mehrere Woerter hat',
          flag: 'on', // kurz, kein Hint → kein Param
        },
      },
    ];
    const fields = suggestParamsFromSingleRun(run)
      .map((p) => p.field)
      .sort();
    expect(fields).toEqual(['blurb', 'ref', 'when']);
  });

  it('Engine/Format-Felder werden nie vorgeschlagen, auch mit texthaftem Wert', () => {
    const run: StepRunConfig[] = [
      {
        label: 'gen',
        values: {
          model: 'deepseek-r1:14b laeuft lokal als Synthese-Engine',
          format: 'eine ausfuehrliche Markdown-Tabelle mit Spalten',
          style: 'sehr sachlich und nuechtern formuliert',
        },
      },
    ];
    expect(suggestParamsFromSingleRun(run)).toEqual([]);
  });

  it('gleicher Feldname in zwei Steps → step-präfixierte, kollisionsfreie Keys', () => {
    const run: StepRunConfig[] = [
      { label: 'a', values: { topic: 'Solar' } },
      { label: 'b', values: { topic: 'Wind' } },
    ];
    const keys = suggestParamsFromSingleRun(run)
      .map((p) => p.key)
      .sort();
    expect(keys).toEqual(['a_topic', 'b_topic']);
    expect(new Set(keys).size).toBe(2); // keine Kollision
  });

  it('keine Kandidaten → leeres Array', () => {
    const run: StepRunConfig[] = [{ label: 's', values: { enabled: 'true', mode: 'fast' } }];
    expect(suggestParamsFromSingleRun(run)).toEqual([]);
  });
});
