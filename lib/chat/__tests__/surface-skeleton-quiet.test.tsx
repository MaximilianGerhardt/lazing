/**
 * SurfaceSkeleton — Apple-UX Slice 1 (2026-05-30).
 *
 * Owner-Schmerz: „SURFACE STREAMT steht die ganze Zeit da".
 * Fix: Das „{LABEL} streamt …"-Status-Wort ist aus dem Produkt gestrichen.
 * Statt eines Text-Platzhalters zeichnet der Skeleton die STRUKTUR der
 * kommenden Card vor (Phase-Outline-Pills + Brand-Progress-Hairline).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/chat/__tests__/surface-skeleton-quiet.test.tsx
 *
 * Cases:
 *   1. Kein „streamt"-Wort mehr im gerenderten Markup (egal welcher Kind).
 *   2. role=status + aria-busy + data-test bleiben erhalten (a11y/Hooks).
 *   3. Reserved-Height pro Kind bleibt gesetzt (Layout-Sprung-Schutz).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { SurfaceSkeleton } from '../SurfaceSkeleton';
import type { SurfaceKind } from '../surface-parser';

function markup(kind: SurfaceKind): string {
  return renderToStaticMarkup(createElement(SurfaceSkeleton, { kind }));
}

describe('SurfaceSkeleton — quiet form pre-drawing (Slice 1)', () => {
  it('rendert NIE das Wort „streamt" (auch nicht „STREAMT")', () => {
    const kinds: SurfaceKind[] = [
      'chart',
      'decision',
      'ticket',
      'pipeline',
      'swarm',
    ] as SurfaceKind[];
    for (const k of kinds) {
      const html = markup(k);
      expect(html.toLowerCase()).not.toContain('streamt');
      expect(html.toLowerCase()).not.toContain('surface streamt');
    }
  });

  it('behält role=status, aria-busy und data-test (a11y + Test-Hooks)', () => {
    const html = markup('chart' as SurfaceKind);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-test="surface-skeleton"');
    expect(html).toContain('data-kind="chart"');
  });

  it('behält die kind-spezifische Reserved-Height (kein Layout-Sprung)', () => {
    // chart = 200 laut KIND_HEIGHT, unbekanntes Kind fällt auf 140 zurück.
    expect(markup('chart' as SurfaceKind)).toContain('height:200px');
    expect(markup('milestone' as SurfaceKind)).toContain('height:140px');
  });

  it('zeichnet eine Brand-Progress-Hairline + Phase-Outline vor', () => {
    const html = markup('decision' as SurfaceKind);
    // Hairline nutzt den Brand-Token --a-now (Akzent nur auf Highlight).
    expect(html).toContain('--a-now');
    // Mehrere Outline-Elemente (Pills/Rows) statt eines einzelnen Labels.
    expect(html).toContain('aria-hidden="true"');
  });
});
