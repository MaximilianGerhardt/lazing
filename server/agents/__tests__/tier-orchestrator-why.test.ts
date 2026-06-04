// P0.3b — Self-Learning / WARUM-Engine (2026-05-27).
//
// Der Tier-Lead-Prompt bekommt nun — neben dem bestehenden RAG/Twin-Enrichment —
// einen WARUM-Block (frühere Begründungen + aktive, gewichtete Beliefs dieses
// Workspace, READ-ONLY aus lib/reasoning/why-context.ts). Der eigentliche
// Lead-Spawn ist tmux-basiert (integration-getestet, nicht unit-testbar); die
// load-bearing Prompt-Komposition ist in die reine Helper-Funktion
// `injectWhyIntoLeadSystem(base, whyBlock)` extrahiert — genau die testen wir
// hier isoliert.
//
// Vertrag (spiegelt das RAG-Enrichment-Muster `${base}\n\n---\n${ctx}`):
//   - nicht-leerer Block ⇒ wird mit "---"-Trenner ANGEHÄNGT (Reihenfolge fix)
//   - leerer/whitespace-only Block ⇒ base UNVERÄNDERT (bit-identisch, fail-soft)
//
// Runner: NODE_OPTIONS="--experimental-require-module" node_modules/.bin/vitest run

import { describe, expect, it } from 'vitest';

import { injectWhyIntoLeadSystem } from '../tier-orchestrator';

const BASE = 'Du bist der Lead-Planer eines laz.ing-Workstreams.\nSchreibe einen Plan.';

const WHY_BLOCK = [
  '── Frühere Entscheidungen in diesem Workspace / warum ──',
  'Jüngste Begründungen:',
  '  - [Routing] Higgsfield für Motion gewählt [Agent]',
  '── Ende früherer Kontext (nutze ihn für konsistente, begründete Empfehlungen) ──',
].join('\n');

describe('injectWhyIntoLeadSystem — P0.3b WARUM-Block im Tier-Lead-Prompt', () => {
  it('nicht-leerer Block → angehängt mit "---"-Trenner, base bleibt VORN', () => {
    const out = injectWhyIntoLeadSystem(BASE, WHY_BLOCK);
    // base steht am Anfang, der WARUM-Block folgt.
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('Frühere Entscheidungen in diesem Workspace');
    expect(out).toContain('Higgsfield für Motion gewählt');
    // Trenner zwischen base und Block (gleiches Muster wie RAG-Enrichment).
    expect(out).toBe(`${BASE}\n\n---\n${WHY_BLOCK}`);
    // base steht VOR dem Block.
    expect(out.indexOf(BASE)).toBeLessThan(out.indexOf('Frühere Entscheidungen'));
  });

  it('leerer Block → base bit-identisch (fail-soft, kein Trenner)', () => {
    expect(injectWhyIntoLeadSystem(BASE, '')).toBe(BASE);
  });

  it('whitespace-only Block → base bit-identisch', () => {
    expect(injectWhyIntoLeadSystem(BASE, '   \n\t  ')).toBe(BASE);
  });

  it('non-string Block → base bit-identisch (defensiv)', () => {
    // @ts-expect-error — bewusster Laufzeit-Schutz gegen undefined-Input.
    expect(injectWhyIntoLeadSystem(BASE, undefined)).toBe(BASE);
  });
});
