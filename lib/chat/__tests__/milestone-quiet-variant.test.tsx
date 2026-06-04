/**
 * MilestoneCard --quiet + event-to-surface synthesis-Mapping (Apple-UX Slice 1).
 *
 * Owner-Schmerz: „Plan-Synthese fertig" überstrahlt das blockierende Gate.
 * Fix: Synthesis-Milestone bekommt `variant:'quiet'` → ruhige Info-Zeile statt
 * der großen Keynote-Card. Info bleibt vollständig erhalten (NICHT gelöscht).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/milestone-quiet-variant.test.tsx
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { renderSurface } from '../SurfaceRenderer';
import { eventToSurface } from '../event-to-surface';

function markupOf(node: React.ReactNode): string {
  return renderToStaticMarkup(createElement('div', null, node));
}

describe('MilestoneCard --quiet (Slice 1)', () => {
  it('quiet-Variante rendert ruhige Info-Zeile, Info bleibt erhalten', () => {
    const html = markupOf(
      renderSurface('milestone', {
        variant: 'quiet',
        headline: 'Plan-Synthese fertig',
        sub: 'Konsolidiert aus 3 Sub-Agent-Outputs',
        bullets: ['Plan-Doc bereit', 'Offene Fragen'],
        href: '/workstreams/WS-1',
      }),
    );
    // Quiet-Markup + erhaltene Info.
    expect(html).toContain('srf-milestone--quiet');
    expect(html).toContain('data-test="milestone-quiet"');
    expect(html).toContain('Plan-Synthese fertig');
    expect(html).toContain('Konsolidiert aus 3 Sub-Agent-Outputs');
    expect(html).toContain('Plan-Doc bereit');
    expect(html).toContain('/workstreams/WS-1');
    // NICHT die laute Keynote-Headline-Klasse / kein Done-Badge-Triumph.
    expect(html).not.toContain('srf-milestone__headline');
    expect(html).not.toContain('✓ Done');
  });

  it('laute Default-Milestone bleibt unverändert (Back-Compat)', () => {
    const html = markupOf(
      renderSurface('milestone', { headline: 'Feature gebaut' }),
    );
    expect(html).toContain('srf-milestone__headline');
    expect(html).not.toContain('srf-milestone--quiet');
  });
});

describe('event-to-surface — synthesis → quiet milestone', () => {
  it('commented kind=synthesis emittiert variant:quiet milestone', () => {
    const res = eventToSurface({
      type: 'commented',
      actor: 'system',
      entityId: 'ticket-1',
      payload: {
        kind: 'synthesis',
        text: '## Plan steht\n- Schritt A\n- Schritt B',
        workstreamId: 'WS-9',
        n_inputs: 4,
      },
    } as never);
    expect(res).not.toBeNull();
    expect(res?.text ?? '').toContain('<surface:milestone>');
    expect(res?.text ?? '').toContain('"variant":"quiet"');
  });
});
