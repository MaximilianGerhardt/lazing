/**
 * Bug-5-Fix · Frage-3×-im-DOM-Dedup · 2026-05-30
 * -----------------------------------------------
 * Live-Browser-Befund (verbatim): Dieselbe offene Frage erscheint DREIMAL —
 *   (1) Markdown-Section in der Assistant-Bubble,
 *   (2) inline interaktive Surface (`<surface:open-questions>` /
 *       `<surface:prompt variant=…>`),
 *   (3) gepinnt in der Pille über dem Composer.
 *
 * FIX: `stripPinnedQuestionSurfaces(content, pinnedIds)` entfernt die zur Pille
 * gehörenden Frage-Surface-/Markdown-Spans aus dem Bubble-Content. Die Pille
 * bleibt die kanonische interaktive Quelle (keine Duplikate mehr).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/strip-pinned-question-surfaces.test.ts
 */

import { describe, expect, it } from 'vitest';

import { stripPinnedQuestionSurfaces } from '../ChatShell';
import { extractOpenQuestionsFromContent } from '../open-questions-lifecycle';

/** Hilfs-Helper: leitet die gepinnten IDs aus dem Content ab (so wie es die
 *  Pille via collectOpenQuestionsFromHistory tut). */
function pinnedFrom(content: string): Set<string> {
  return new Set(extractOpenQuestionsFromContent(content).map((q) => q.id));
}

describe('stripPinnedQuestionSurfaces · Bug-5 (Frage-3×-im-DOM-Dedup)', () => {
  it('entfernt eine <surface:open-questions>, deren Fragen gepinnt sind', () => {
    const content =
      'Hier ist mein Vorschlag.\n' +
      '<surface:open-questions>' +
      JSON.stringify({
        questions: [{ id: 'q-copy-design', q: 'Erst Copy oder erst Design?' }],
      }) +
      '</surface:open-questions>\n' +
      'Danach geht es weiter.';
    const pinned = pinnedFrom(content);
    expect(pinned.has('q-copy-design')).toBe(true);

    const out = stripPinnedQuestionSurfaces(content, pinned);
    expect(out.changed).toBe(true);
    // Surface-Tag ist weg — kein Zwilling zur Pille.
    expect(out.content).not.toContain('<surface:open-questions>');
    expect(out.content).not.toContain('Erst Copy oder erst Design?');
    // Umgebender Prosa-Text bleibt erhalten.
    expect(out.content).toContain('Hier ist mein Vorschlag.');
    expect(out.content).toContain('Danach geht es weiter.');
  });

  it('entfernt die `## Offene Fragen`-Markdown-Section, wenn gepinnt', () => {
    const content =
      '## User-Sicht\nWir bauen die Seite.\n\n' +
      '## Offene Fragen\n' +
      '- [?] Welcher Akzent? | OPTIONS: Blau | Grün\n\n' +
      '## Nächster Schritt\nLos.';
    const pinned = pinnedFrom(content);
    expect(pinned.size).toBe(1);

    const out = stripPinnedQuestionSurfaces(content, pinned);
    expect(out.changed).toBe(true);
    expect(out.content).not.toContain('Welcher Akzent?');
    // Vor- und Nach-Sektionen bleiben.
    expect(out.content).toContain('Wir bauen die Seite.');
    expect(out.content).toContain('## Nächster Schritt');
  });

  it('lässt Surfaces unberührt, deren Fragen NICHT gepinnt sind', () => {
    const content =
      '<surface:open-questions>' +
      JSON.stringify({ questions: [{ id: 'q-other', q: 'Andere Frage?' }] }) +
      '</surface:open-questions>';
    // Pille hält eine ANDERE Frage.
    const pinned = new Set(['q-not-this-one']);

    const out = stripPinnedQuestionSurfaces(content, pinned);
    expect(out.changed).toBe(false);
    expect(out.content).toBe(content);
  });

  it('lässt fremde Surfaces (z.B. chart) unberührt, auch bei gepinnter Frage', () => {
    const content =
      '<surface:chart>' +
      JSON.stringify({ type: 'bar', data: [1, 2, 3] }) +
      '</surface:chart>\n' +
      '<surface:open-questions>' +
      JSON.stringify({ questions: [{ id: 'q-x', q: 'Frage X?' }] }) +
      '</surface:open-questions>';
    const pinned = pinnedFrom(content);

    const out = stripPinnedQuestionSurfaces(content, pinned);
    expect(out.changed).toBe(true);
    // Chart bleibt, Frage-Surface weg.
    expect(out.content).toContain('<surface:chart>');
    expect(out.content).not.toContain('<surface:open-questions>');
  });

  it('strippt `<surface:prompt variant=open-questions>` aber NICHT variant=quickchoice', () => {
    const oqPrompt =
      '<surface:prompt>' +
      JSON.stringify({
        variant: 'open-questions',
        questions: [{ id: 'q-prompt', q: 'Prompt-Frage?' }],
      }) +
      '</surface:prompt>';
    const quickchoice =
      '<surface:prompt>' +
      JSON.stringify({
        variant: 'quickchoice',
        options: [{ id: 'opt-a', label: 'A' }],
      }) +
      '</surface:prompt>';
    const content = `${oqPrompt}\n${quickchoice}`;
    // Die Pille pinnt die Prompt-Frage über ihre Payload-id `q-prompt`.
    const pinned = new Set(['q-prompt']);

    const out = stripPinnedQuestionSurfaces(content, pinned);
    expect(out.changed).toBe(true);
    // quickchoice (Flow-Style-Wahl) bleibt — nur frage-tragende Prompts gehen.
    expect(out.content).toContain('"variant":"quickchoice"');
    expect(out.content).not.toContain('Prompt-Frage?');
  });

  it('no-op bei leerem Pin-Set (Backward-Compat)', () => {
    const content =
      '<surface:open-questions>' +
      JSON.stringify({ questions: [{ id: 'q', q: 'Frage?' }] }) +
      '</surface:open-questions>';
    const out = stripPinnedQuestionSurfaces(content, new Set());
    expect(out.changed).toBe(false);
    expect(out.content).toBe(content);
  });

  it('teil-gepinnt: Surface bleibt, wenn NICHT alle ihre Fragen gepinnt sind', () => {
    const content =
      '<surface:open-questions>' +
      JSON.stringify({
        questions: [
          { id: 'q-1', q: 'Frage 1?' },
          { id: 'q-2', q: 'Frage 2?' },
        ],
      }) +
      '</surface:open-questions>';
    // Nur eine der beiden ist gepinnt → Surface bleibt vollständig stehen,
    // sonst verlöre der User die nicht-gepinnte Frage.
    const pinned = new Set(['q-1']);
    const out = stripPinnedQuestionSurfaces(content, pinned);
    expect(out.changed).toBe(false);
    expect(out.content).toBe(content);
  });
});
