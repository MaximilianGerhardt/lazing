/**
 * parse-plan-questions — De-Dupe der Tiefe-/Spawn-Frage (Bug-Report Max,
 * 2026-05-26). Der Depth-Picker (SubplanCard) besitzt die Tiefe-Entscheidung;
 * dieselbe Frage darf NICHT zusätzlich als offene Frage erscheinen.
 */
import { describe, expect, it } from 'vitest';
import { parsePlanQuestions } from '../parse-plan-questions';

describe('parsePlanQuestions — depth/spawn de-dupe', () => {
  const plan = `# Plan
## Offene Fragen
- [?] Build-Tiefe? | OPTIONS: Schnell | Standard | Tief
- [?] Erst Copy oder erst Design? | OPTIONS: Copy | Design
- [?] Wie viele Agenten? | OPTIONS: 1 | 4 | 8
- [?] Tech-Stack? | OPTIONS: Next.js | Astro
`;

  it('drops depth + agent-count questions, keeps content questions', () => {
    const qs = parsePlanQuestions(plan).map((q) => q.text);
    expect(qs).not.toContain('Build-Tiefe?');
    expect(qs.some((t) => /tiefe/i.test(t))).toBe(false);
    expect(qs.some((t) => /wie viele agent/i.test(t))).toBe(false);
    // Inhaltliche Fragen bleiben:
    expect(qs).toContain('Erst Copy oder erst Design?');
    expect(qs).toContain('Tech-Stack?');
    expect(qs).toHaveLength(2);
  });

  it('keeps a legit question containing the substring "tief" (no false positive)', () => {
    const p = `## Offene Fragen
- [?] Wie tiefgehend soll die Wettbewerbsanalyse sein? | OPTIONS: Knapp | Ausführlich
`;
    const qs = parsePlanQuestions(p).map((q) => q.text);
    // `\bwie\s+tief\b` matcht NICHT "wie tiefgehend" (keine Wortgrenze nach
    // "tief") → die inhaltliche Frage bleibt erhalten.
    expect(qs).toContain('Wie tiefgehend soll die Wettbewerbsanalyse sein?');
    expect(qs).toHaveLength(1);
  });
});
