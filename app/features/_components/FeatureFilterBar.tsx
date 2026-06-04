'use client';

// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// app/features/_components/FeatureFilterBar — client island, browser-only.
//
// Task: filter (category, status, on-top) + search. Since the catalog is static
// (build-time), this client component filters the ALREADY-rendered DOM
// list via [data-…] attributes + display:none — NO re-render, no re-fetch,
// no hydration tax across the whole list. This keeps the page SSR-friendly +
// renders fully right away, even with JS off (then without filters, but readable).

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import {
  CATEGORY_ORDER,
  type FeatureCategory,
  type FeatureStatus,
  type FeatureOnTop,
} from '@/lib/features/catalog';

const STATUSES: readonly FeatureStatus[] = [
  'live',
  'owner-gated',
  'dev',
  'planned',
  'deferred',
];

const ONTOPS: readonly FeatureOnTop[] = ['claude-code', 'codex', 'both', 'standalone'];

interface Props {
  /** Provided feature roots to filter (selector via [data-feature-id]). */
  readonly featuresSelector?: string;
}

export function FeatureFilterBar({
  featuresSelector = '[data-feature-id]',
}: Props): React.ReactElement {
  const [category, setCategory] = useState<FeatureCategory | 'all'>('all');
  const [status, setStatus] = useState<FeatureStatus | 'all'>('all');
  const [onTop, setOnTop] = useState<FeatureOnTop | 'all'>('all');
  const [search, setSearch] = useState('');

  const rootRef = useRef<HTMLDivElement | null>(null);

  // Filter effect: read all DOM cards + set the hidden attribute.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(featuresSelector),
    );
    const q = search.trim().toLowerCase();
    let visible = 0;
    for (const c of cards) {
      const cat = c.dataset.category ?? '';
      const st = c.dataset.status ?? '';
      const ot = c.dataset.ontop ?? '';
      const haystack = (c.dataset.search ?? '').toLowerCase();
      const okCat = category === 'all' || cat === category;
      const okSt = status === 'all' || st === status;
      const okOt = onTop === 'all' || ot === onTop;
      const okQ = q.length === 0 || haystack.includes(q);
      const show = okCat && okSt && okOt && okQ;
      c.style.display = show ? '' : 'none';
      if (show) visible++;
    }
    // Hide empty category sections.
    const sections = document.querySelectorAll<HTMLElement>('[data-category-section]');
    sections.forEach((sec) => {
      const sectCat = sec.dataset.categorySection ?? '';
      const hasVisible = Array.from(
        sec.querySelectorAll<HTMLElement>(featuresSelector),
      ).some((c) => c.style.display !== 'none');
      sec.style.display = hasVisible ? '' : 'none';
      // Also toggle our anchor nav items (data-anchor=<cat-slug>).
      const anchorSlug = sec.dataset.anchorSlug ?? '';
      if (anchorSlug) {
        const navEl = document.querySelector<HTMLElement>(
          `[data-anchor="${anchorSlug}"]`,
        );
        if (navEl) navEl.style.opacity = hasVisible ? '1' : '0.35';
      }
      void sectCat; // dataset noise-quiet
    });
    // Empty-state marker
    const empty = document.querySelector<HTMLElement>('[data-empty-state]');
    if (empty) empty.style.display = visible === 0 ? '' : 'none';
  }, [category, status, onTop, search, featuresSelector]);

  const reset = () => {
    setCategory('all');
    setStatus('all');
    setOnTop('all');
    setSearch('');
  };

  const filterActive = useMemo(
    () =>
      category !== 'all' ||
      status !== 'all' ||
      onTop !== 'all' ||
      search.trim().length > 0,
    [category, status, onTop, search],
  );

  return (
    <div ref={rootRef} style={barStyle}>
      <div style={rowStyle}>
        <label style={labelStyle} htmlFor="ff-search">
          Suche
        </label>
        <input
          id="ff-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Feature, Mechanik, Pfad…"
          style={searchInputStyle}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div style={rowStyle}>
        <label style={labelStyle} htmlFor="ff-category">
          Kategorie
        </label>
        <select
          id="ff-category"
          value={category}
          onChange={(e) =>
            setCategory((e.target.value as FeatureCategory) || 'all')
          }
          style={selectStyle}
        >
          <option value="all">alle</option>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div style={rowStyle}>
        <label style={labelStyle} htmlFor="ff-status">
          Status
        </label>
        <select
          id="ff-status"
          value={status}
          onChange={(e) => setStatus((e.target.value as FeatureStatus) || 'all')}
          style={selectStyle}
        >
          <option value="all">alle</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div style={rowStyle}>
        <label style={labelStyle} htmlFor="ff-ontop">
          On-Top
        </label>
        <select
          id="ff-ontop"
          value={onTop}
          onChange={(e) => setOnTop((e.target.value as FeatureOnTop) || 'all')}
          style={selectStyle}
        >
          <option value="all">alle</option>
          {ONTOPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      {filterActive && (
        <button type="button" onClick={reset} style={resetBtnStyle}>
          Filter zurücksetzen
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const barStyle: CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: 12,
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 50%, transparent)',
  gridTemplateColumns: 'minmax(0, 1fr)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  minHeight: 44,
};

const labelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
  width: 80,
  flex: '0 0 auto',
};

const searchInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 36,
  padding: '0 12px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-3)',
  color: 'var(--ink)',
  fontSize: 'var(--fs-body)',
  fontFamily: 'var(--font-sans)',
  outline: 'none',
};

const selectStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 36,
  padding: '0 10px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-3)',
  color: 'var(--ink)',
  fontSize: 'var(--fs-body)',
  fontFamily: 'var(--font-sans)',
  outline: 'none',
  appearance: 'none',
  WebkitAppearance: 'none',
};

const resetBtnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  height: 32,
  padding: '0 12px',
  borderRadius: 'var(--radius-pill)',
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  cursor: 'pointer',
};
