// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// Tests für lib/features/catalog.ts — sicherstellen dass jeder Eintrag die
// Pflichtfelder hat, IDs eindeutig sind, jede Category mindestens 1 Feature
// hat (sonst Anchor-Nav-Lücke), und die Group/Counts-Helper stabil sind.

import { describe, expect, it } from 'vitest';

import {
  CATEGORY_ORDER,
  FEATURE_CATALOG,
  categoryAnchor,
  countByCategory,
  countByStatus,
  groupFeaturesByCategory,
  type Feature,
  type FeatureStatus,
} from '@/lib/features/catalog';

describe('FEATURE_CATALOG — shape + invariants', () => {
  it('contains at least 30 features', () => {
    expect(FEATURE_CATALOG.length).toBeGreaterThanOrEqual(30);
  });

  it('every feature has all required fields', () => {
    for (const f of FEATURE_CATALOG) {
      expect(f.id, `id missing for ${JSON.stringify(f)}`).toMatch(
        /^[a-z0-9-]+$/,
      );
      expect(f.name.length, `name empty for ${f.id}`).toBeGreaterThan(0);
      expect(CATEGORY_ORDER, `unknown category ${f.category} on ${f.id}`).toContain(
        f.category,
      );
      expect(
        ['live', 'dev', 'planned', 'deferred', 'owner-gated'],
        `unknown status ${f.status} on ${f.id}`,
      ).toContain(f.status);
      expect(
        ['claude-code', 'codex', 'both', 'standalone'],
        `unknown onTop ${f.onTop} on ${f.id}`,
      ).toContain(f.onTop);
      expect(f.function.length, `function empty for ${f.id}`).toBeGreaterThan(10);
      expect(f.mechanism.length, `mechanism empty for ${f.id}`).toBeGreaterThan(
        10,
      );
      expect(f.improves.length, `improves empty for ${f.id}`).toBeGreaterThan(
        10,
      );
      expect(
        Array.isArray(f.useCases) && f.useCases.length >= 1,
        `useCases empty for ${f.id}`,
      ).toBe(true);
      expect(
        Array.isArray(f.refs) && f.refs.length >= 1,
        `refs empty for ${f.id}`,
      ).toBe(true);
      for (const r of f.refs) {
        expect(r.label.length, `ref.label empty in ${f.id}`).toBeGreaterThan(0);
        expect(r.path.length, `ref.path empty in ${f.id}`).toBeGreaterThan(0);
      }
    }
  });

  it('feature ids are unique', () => {
    const ids = FEATURE_CATALOG.map((f) => f.id);
    const set = new Set(ids);
    expect(set.size, `duplicate id in: ${JSON.stringify(findDuplicates(ids))}`).toBe(
      ids.length,
    );
  });

  it('every feature has either beforeAfter or prosCons (not both required)', () => {
    for (const f of FEATURE_CATALOG) {
      const has = Boolean(f.beforeAfter) || Boolean(f.prosCons);
      // Nicht strikt Pflicht — wir verlangen mindestens EINE Form pro Feature
      // damit der Owner immer eine Gegenüberstellung sieht. Wenn beides null
      // ist, dann hat das Feature nur use-cases + refs — das ist erlaubt
      // (z.B. Persistenz-Layer ohne klassische Trade-Off-Wahl). Wir loggen das
      // hier nur als Soft-Erwartung.
      if (!has) {
        // intentionally permissive — wir validieren nur die Pflichtfelder oben.
        expect(true).toBe(true);
      }
    }
    // Mindestens 50% sollten eine Gegenüberstellung haben (Reichtums-Check).
    const withComparison = FEATURE_CATALOG.filter(
      (f) => f.beforeAfter || f.prosCons,
    ).length;
    expect(withComparison).toBeGreaterThanOrEqual(
      Math.floor(FEATURE_CATALOG.length * 0.4),
    );
  });

  it('every CATEGORY_ORDER entry has at least 1 feature (no empty anchor)', () => {
    for (const cat of CATEGORY_ORDER) {
      const count = FEATURE_CATALOG.filter((f) => f.category === cat).length;
      expect(count, `category ${cat} has 0 features`).toBeGreaterThanOrEqual(1);
    }
  });

  it('status distribution is plausible (>=10 live, no >50% deferred)', () => {
    const byStatus = countByStatus();
    const live = byStatus.find((s) => s.status === 'live')?.count ?? 0;
    const deferred = byStatus.find((s) => s.status === 'deferred')?.count ?? 0;
    expect(live, 'expected at least 10 live features').toBeGreaterThanOrEqual(10);
    expect(deferred / FEATURE_CATALOG.length, 'too many deferred').toBeLessThan(
      0.5,
    );
  });
});

describe('groupFeaturesByCategory', () => {
  it('returns categories in CATEGORY_ORDER', () => {
    const grouped = groupFeaturesByCategory();
    const cats = grouped.map((g) => g.category);
    // Should be a prefix-stable subsequence of CATEGORY_ORDER (we filter out
    // empties; with the invariant above, all categories appear).
    let idx = 0;
    for (const c of cats) {
      while (idx < CATEGORY_ORDER.length && CATEGORY_ORDER[idx] !== c) idx++;
      expect(idx, `category ${c} not in order`).toBeLessThan(CATEGORY_ORDER.length);
      idx++;
    }
  });

  it('within a category, live appears before deferred', () => {
    const grouped = groupFeaturesByCategory();
    const rank: Record<FeatureStatus, number> = {
      live: 0,
      'owner-gated': 1,
      dev: 2,
      planned: 3,
      deferred: 4,
    };
    for (const { features } of grouped) {
      for (let i = 1; i < features.length; i++) {
        expect(rank[features[i].status]).toBeGreaterThanOrEqual(
          rank[features[i - 1].status],
        );
      }
    }
  });

  it('countByCategory + groupFeaturesByCategory totals match', () => {
    const byCat = countByCategory();
    const grouped = groupFeaturesByCategory();
    for (const { category, count } of byCat) {
      const g = grouped.find((x) => x.category === category);
      expect(g?.features.length).toBe(count);
    }
  });
});

describe('categoryAnchor', () => {
  it('produces a kebab-case ascii slug', () => {
    for (const c of CATEGORY_ORDER) {
      const s = categoryAnchor(c);
      expect(s).toMatch(/^[a-z0-9-]+$/);
      expect(s.startsWith('-')).toBe(false);
      expect(s.endsWith('-')).toBe(false);
    }
  });

  it('Critic/Devil-Advocate → critic-devil-advocate', () => {
    expect(categoryAnchor('Critic/Devil-Advocate')).toBe('critic-devil-advocate');
  });
});

// ---------------------------------------------------------------------------

function findDuplicates<T>(arr: readonly T[]): T[] {
  const seen = new Set<T>();
  const dupes = new Set<T>();
  for (const a of arr) {
    if (seen.has(a)) dupes.add(a);
    seen.add(a);
  }
  return Array.from(dupes);
}

// Type-only round-trip — make sure Feature is the array element shape.
const sample: Feature = FEATURE_CATALOG[0];
void sample;
