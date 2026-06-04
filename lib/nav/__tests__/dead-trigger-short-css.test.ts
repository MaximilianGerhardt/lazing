/**
 * Dead-CSS-Guard (Apple-UX Slice 1 — FIX 2, 2026-05-30).
 *
 * Die `.topnav-org-trigger-short` / `.topnav-ws-trigger-short`-Spans wurden in
 * Slice 1 aus dem JSX entfernt (volles Label statt 3-Buchstaben-Stummel —
 * siehe switcher-full-label.test.tsx). Die CSS-Regeln waren danach toter Code.
 * Dieser Test fixiert, dass sie aus `app/components.css` raus sind und nicht
 * versehentlich wieder reinwachsen (Disziplin-Blocker des Critics).
 *
 * Run:
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/nav/__tests__/dead-trigger-short-css.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPONENTS_CSS = join(process.cwd(), 'app', 'components.css');

describe('dead-CSS-Guard — trigger-short Klassen entfernt (FIX 2)', () => {
  it('app/components.css enthält keine .topnav-*-trigger-short-Regel mehr', () => {
    const css = readFileSync(COMPONENTS_CSS, 'utf8');
    const orgHits = css.match(/\.topnav-org-trigger-short/g) ?? [];
    const wsHits = css.match(/\.topnav-ws-trigger-short/g) ?? [];
    expect(orgHits).toHaveLength(0);
    expect(wsHits).toHaveLength(0);
  });
});
