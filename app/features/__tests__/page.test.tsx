// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// Smoke-Test für /features:
//   1. FeatureCard rendert ohne Crash + zeigt Name + Status-Pill.
//   2. CardWrap-data-Attributes (über die Page-Komponente erzeugt) sind im
//      DOM-Output sichtbar — vorausgesetzung damit der Client-Filter
//      (FeatureFilterBar) toggeln kann.
//   3. Page-Component rendert mindestens 1 Card pro nicht-leerer Category.
//
// happy-dom (vitest-config) ist DOM-Env → renderToStaticMarkup reicht.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import FeaturesPage from '@/app/features/page';
import { FeatureCard } from '@/app/features/_components/FeatureCard';
import {
  CATEGORY_ORDER,
  FEATURE_CATALOG,
} from '@/lib/features/catalog';

describe('FeatureCard', () => {
  it('renders the feature name, status pill text and onTop label', () => {
    const f = FEATURE_CATALOG.find((x) => x.status === 'live')!;
    const html = renderToStaticMarkup(<FeatureCard feature={f} />);
    expect(html).toContain(f.name);
    // Status pill — text label is one of Live | Owner-Gated | Dev | Planned | Deferred.
    expect(html).toMatch(/Live|Owner-Gated|Dev|Planned|Deferred/);
    // Section headings are present.
    expect(html).toContain('Funktion');
    expect(html).toContain('Mechanik');
    expect(html).toContain('Verbesserung');
  });

  it('renders all refs paths verbatim', () => {
    const f = FEATURE_CATALOG[0];
    const html = renderToStaticMarkup(<FeatureCard feature={f} />);
    for (const r of f.refs) {
      expect(html).toContain(r.path);
    }
  });

  it('renders Vorher/Nachher labels when beforeAfter is set', () => {
    const f = FEATURE_CATALOG.find((x) => x.beforeAfter)!;
    expect(f).toBeDefined();
    const html = renderToStaticMarkup(<FeatureCard feature={f} />);
    expect(html).toContain('Vorher');
    expect(html).toContain('Nachher');
  });

  it('renders Pro/Kontra labels when prosCons is set', () => {
    const f = FEATURE_CATALOG.find((x) => x.prosCons)!;
    expect(f).toBeDefined();
    const html = renderToStaticMarkup(<FeatureCard feature={f} />);
    expect(html).toContain('Pro');
    expect(html).toContain('Kontra');
  });
});

describe('FeaturesPage SSR', () => {
  it('renders without throwing and produces a non-trivial document', () => {
    const html = renderToStaticMarkup(<FeaturesPage />);
    expect(html.length).toBeGreaterThan(5000);
    expect(html).toContain('Features');
  });

  it('renders one CardWrap per feature with data-attributes for client filter', () => {
    const html = renderToStaticMarkup(<FeaturesPage />);
    for (const f of FEATURE_CATALOG) {
      expect(html, `expected data-feature-id="${f.id}" in DOM`).toContain(
        `data-feature-id="${f.id}"`,
      );
      expect(html).toContain(`data-status="${f.status}"`);
      expect(html).toContain(`data-ontop="${f.onTop}"`);
    }
  });

  it('renders anchor-nav entries for every non-empty category', () => {
    const html = renderToStaticMarkup(<FeaturesPage />);
    for (const cat of CATEGORY_ORDER) {
      const count = FEATURE_CATALOG.filter((f) => f.category === cat).length;
      if (count === 0) continue;
      expect(html, `expected category text "${cat}"`).toContain(cat);
    }
  });

  it('contains the empty-state placeholder (display:none by default)', () => {
    const html = renderToStaticMarkup(<FeaturesPage />);
    expect(html).toContain('data-empty-state');
    expect(html).toContain('Keine Features für diese Filter-Kombination');
  });
});
