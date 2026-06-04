/**
 * surface-text-render — Last-known-good statt Dauer-Skeleton (Apple-UX Slice 1).
 *
 * Owner-Schmerz: „SURFACE STREAMT steht die ganze Zeit da". Solange der Agent
 * dieselbe Card re-streamt (emitOrUpdateCard-Re-Emit), flippte der Renderer auf
 * den Skeleton zurück. Fix: wurde dieselbe Coord schon EINMAL valide gerendert,
 * zeigen wir die VORIGE Version weiter statt des Skeletons. Skeleton NUR beim
 * allerersten Frame einer nie-gesehenen Coord.
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/surface-last-known-good.test.tsx
 *
 * Cases:
 *   1. Nie-gesehene Coord + unbalancierter Tail → Skeleton (erster Frame).
 *   2. Coord schon valide gerendert → späterer unbalancierter Tail derselben
 *      Coord zeigt last-known-good (kein Skeleton, kein Rohtext).
 *   3. Anderer (nie-gesehener) Coord-Tail bleibt Skeleton (keine Cross-Coord-
 *      Verwechslung).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { renderChatText } from '../surface-text-render';

function markupOf(node: React.ReactNode): string {
  return renderToStaticMarkup(createElement('div', null, node));
}

const FULL = (ws: string, headline: string) =>
  `<surface:milestone>${JSON.stringify({
    workstreamId: ws,
    headline,
    bullets: ['A', 'B'],
  })}</surface:milestone>`;

// Unbalancierter Tail derselben Coord (kein schließendes Tag → streamt).
const PARTIAL = (ws: string) =>
  `<surface:milestone>{"workstreamId":"${ws}","headline":"neu`;

describe('surface-text-render — last-known-good (Slice 1)', () => {
  it('zeigt Skeleton beim allerersten Frame einer nie-gesehenen Coord', () => {
    const html = markupOf(renderChatText('Vorlauf\n' + PARTIAL('WS-NEW-1')));
    expect(html).toContain('data-test="surface-skeleton"');
    expect(html).not.toContain('data-test="surface-last-known-good"');
  });

  it('zeigt nach valider Render die vorige Version statt Skeleton bei Re-Stream', () => {
    const ws = 'WS-LKG-2';
    // 1) Erst eine vollständige, valide Card derselben Coord rendern → cacht.
    const full = markupOf(renderChatText(FULL(ws, 'Plan-Synthese fertig')));
    expect(full).toContain('Plan-Synthese fertig');

    // 2) Danach ein unbalancierter Tail derselben Coord (Re-Stream).
    const reStream = markupOf(renderChatText('Update\n' + PARTIAL(ws)));
    expect(reStream).toContain('data-test="surface-last-known-good"');
    // Key-Format (FIX 1, 2026-05-30): `${wsScope}::${kind}::${identity}`.
    expect(reStream).toContain(
      'data-surface-coord="ws:_::milestone::ws:' + ws + '"',
    );
    // Kein Skeleton, kein Rohtext-Leak des partiellen Tags.
    expect(reStream).not.toContain('data-test="surface-skeleton"');
    expect(reStream).not.toContain('"headline":"neu');
    // Die vorige Inhalts-Headline ist weiterhin sichtbar.
    expect(reStream).toContain('Plan-Synthese fertig');
  });

  it('greift für milestone OHNE workstreamId/subKey via headline-Hash (FIX 1, der Blocker)', () => {
    // Der Plan-Synthese-`milestone` (event-to-surface.ts:636) trägt KEIN
    // workstreamId und KEIN subKey — nur `headline`. Vor FIX 1 keyte der Cache
    // nie → genau diese (wichtigste) Card fiel bei jedem Re-Stream auf den
    // Skeleton zurück. Der headline-Hash-Fallback schließt das.
    const headline = 'Plan-Synthese fertig';
    const FULL_NO_WS = `<surface:milestone>${JSON.stringify({
      variant: 'quiet',
      headline,
      sub: 'Konsolidiert aus 5 Sub-Agent-Outputs',
      bullets: ['Plan-Doc bereit', 'User-Sicht'],
    })}</surface:milestone>`;

    // 1) Erst-Render der vollständigen Card → cacht unter headline-Hash.
    const first = markupOf(renderChatText(FULL_NO_WS));
    expect(first).toContain(headline);

    // 2) Re-Stream: unbalancierter Tail derselben Card (kein schließendes Tag),
    //    aber mit VOLLSTÄNDIGER headline (so weit ist der Stream schon) und KEIN
    //    ws/subKey. Last-known-good muss greifen — kein Skeleton mehr.
    const partialNoWs =
      `<surface:milestone>{"variant":"quiet","headline":"${headline}","sub":"Konsolidiert aus 5`;
    const reStream = markupOf(renderChatText('Update\n' + partialNoWs));

    expect(reStream).toContain('data-test="surface-last-known-good"');
    expect(reStream).not.toContain('data-test="surface-skeleton"');
    // Vorige Card weiterhin sichtbar, kein Rohtext-Leak des partiellen Tags.
    expect(reStream).toContain(headline);
    expect(reStream).not.toContain('"variant":"quiet"');
    // Coord-Key nutzt den headline-Hash-Slot (`::h:`), nicht ws/sub.
    expect(reStream).toMatch(/data-surface-coord="ws:_::milestone::h:[a-z0-9]+"/);
  });

  it('verwechselt Coords nicht — fremder Tail bleibt Skeleton', () => {
    const known = 'WS-KNOWN-3';
    markupOf(renderChatText(FULL(known, 'Bekannt')));
    // Ein anderer, nie-gesehener Coord-Tail bekommt KEINEN fremden Cache-Hit.
    const other = markupOf(renderChatText(PARTIAL('WS-OTHER-3')));
    expect(other).toContain('data-test="surface-skeleton"');
    expect(other).not.toContain('data-test="surface-last-known-good"');
  });
});
