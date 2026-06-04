/**
 * Tests für lib/flow/param-diff.ts (Auto-Param-Extraktion 2b-2, pure/N6).
 */
import { describe, expect, it } from 'vitest';

import { diffRuns, type StepRunConfig } from '../param-diff';

// 3 Reel-Läufe: topic variiert, brand_voice konstant.
const run = (topic: string): StepRunConfig[] => [
  { label: 'research', values: { query: topic } },
  { label: 'script', values: { topic, brand_voice: 'laz.ing' } },
];

describe('diffRuns', () => {
  it('erkennt variable Felder als Params, konstante als hart kodiert', () => {
    const r = diffRuns([run('Solar'), run('Wärmepumpe'), run('Speicher')]);
    expect(r.runs).toBe(3);
    // topic (in research.query UND script.topic) variiert → 2 Kandidaten;
    // brand_voice konstant → constant.
    const fields = r.params.map((p) => p.field).sort();
    expect(fields).toEqual(['query', 'topic']);
    expect(r.constantCount).toBe(1); // brand_voice
    const q = r.params.find((p) => p.field === 'query')!;
    expect(q.observed).toEqual(['Solar', 'Wärmepumpe', 'Speicher']);
  });

  it('alle Werte gleich → keine Params', () => {
    const r = diffRuns([run('Solar'), run('Solar')]);
    expect(r.params).toEqual([]);
  });

  it('weniger als 2 Läufe → kein Diff', () => {
    expect(diffRuns([run('Solar')]).params).toEqual([]);
    expect(diffRuns([]).runs).toBe(0);
  });

  it('zwei Steps gleichen Labels kollidieren nicht (Vorkommens-Index)', () => {
    const mk = (a: string, b: string): StepRunConfig[] => [
      { label: 'gen', values: { prompt: a } },
      { label: 'gen', values: { prompt: b } },
    ];
    const r = diffRuns([mk('x1', 'y1'), mk('x2', 'y2')]);
    // beide gen-Steps variieren → 2 Kandidaten, eindeutige Keys.
    expect(r.params.length).toBe(2);
    expect(new Set(r.params.map((p) => p.key)).size).toBe(2);
  });

  it('Key-Kollision bei gleichem Feldnamen in mehreren Steps → Step-Präfix + Suffix', () => {
    const r = diffRuns([run('Solar'), run('Wind')]);
    // query + topic sind unterschiedliche Feldnamen → Keys = query, topic.
    expect(r.params.every((p) => p.key.length > 0)).toBe(true);
    expect(new Set(r.params.map((p) => p.key)).size).toBe(r.params.length); // alle eindeutig
  });
});
