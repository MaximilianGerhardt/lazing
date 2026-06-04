// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// /features — Feature-Übersicht aller laz.ing-Aufpfropfungen auf
// Claude Code + Codex. Statisch SSR-rendered aus lib/features/catalog.ts.
//
// Design-Disziplin (laz.ing Design Manifest v1.0):
//   - Pitch-Black Canvas via .sheet + Tokens
//   - SF Pro Display (var(--font-display)) für Titel
//   - 0.5px Lines, --radius-pill, KEINE neuen Hex-Werte, KEIN shadcn
//   - Mobile-first (375px-tauglich): Cards stapeln, Pills wrappen,
//     Filter-Bar 1-Column auf schmal, kein horizontaler Overflow.
//   - Touch-Targets >= 44px (Filter-Bar-Rows).
//
// Filterung läuft im Client (FeatureFilterBar.tsx) durch CSS-Display-Toggle
// auf bereits SSR-gerenderten Cards — kein Re-Fetch, kein Liste-Rebuild.
// → Mit JS off bleibt die Seite trotzdem komplett lesbar.

import type { CSSProperties } from 'react';

import {
  CATEGORY_ORDER,
  FEATURE_CATALOG,
  categoryAnchor,
  countByCategory,
  countByStatus,
  groupFeaturesByCategory,
  type Feature,
} from '@/lib/features/catalog';

import { FeatureCard } from './_components/FeatureCard';
import { FeatureFilterBar } from './_components/FeatureFilterBar';

// Statische SSR — Catalog ist Build-Zeit-konstant.
export const dynamic = 'force-static';

export const metadata = {
  title: 'Features — laz.ing on Claude Code + Codex',
  description:
    'Vollständiger Katalog aller laz.ing-Aufpfropfungen auf Claude Code und Codex: Chat-Surfaces, Flow Studio, Swarm/Plan, Self-Learning, Connectors/SOP, Skills/Roles, Security/Sandbox, RAG.',
};

export default function FeaturesPage(): React.ReactElement {
  const grouped = groupFeaturesByCategory();
  const totalFeatures = FEATURE_CATALOG.length;
  const byCat = countByCategory();
  const byStatus = countByStatus();

  return (
    <main className="sheet" style={mainStyle}>
      <div style={shellStyle}>
        {/* ─── Header ──────────────────────────────────────────────── */}
        <header style={headerStyle}>
          <div style={eyebrowStyle}>laz.ing · on Claude Code + Codex</div>
          <h1 style={h1Style}>Features</h1>
          <p style={leadStyle}>
            Jedes Feature, das laz.ing <em style={emStyle}>on-top</em> der raw
            Claude-Code-/Codex-CLIs gebaut hat — benannt, mit Funktion, Mechanik
            (file:line-belegt), Verbesserung gegenüber dem raw CLI, konkreten
            Use-Cases und entweder einer Vorher/Nachher- oder Pro/Kontra-Gegenüberstellung.
          </p>
          <div style={summaryRowStyle}>
            <SummaryStat label="Features gesamt" value={totalFeatures.toString()} />
            {byStatus.map((s) => (
              <SummaryStat key={s.status} label={s.status} value={s.count.toString()} />
            ))}
          </div>
        </header>

        {/* ─── Filter-Bar ──────────────────────────────────────────── */}
        <div style={{ marginTop: 18 }}>
          <FeatureFilterBar />
        </div>

        {/* ─── Anchor-Nav ──────────────────────────────────────────── */}
        <nav style={navStyle} aria-label="Kategorien">
          {CATEGORY_ORDER.map((cat) => {
            const count = byCat.find((c) => c.category === cat)?.count ?? 0;
            if (count === 0) return null;
            const slug = categoryAnchor(cat);
            return (
              <a
                key={cat}
                href={`#cat-${slug}`}
                data-anchor={slug}
                style={navItemStyle}
              >
                <span>{cat}</span>
                <span style={navCountStyle}>{count}</span>
              </a>
            );
          })}
        </nav>

        {/* ─── Empty-State (toggled by client filter) ─────────────── */}
        <div data-empty-state style={emptyStateStyle}>
          Keine Features für diese Filter-Kombination.
        </div>

        {/* ─── Category-Sections ──────────────────────────────────── */}
        {grouped.map(({ category, features }) => {
          const slug = categoryAnchor(category);
          return (
            <section
              key={category}
              id={`cat-${slug}`}
              data-category-section={category}
              data-anchor-slug={slug}
              style={categorySectionStyle}
            >
              <header style={categoryHeaderStyle}>
                <h2 style={h2Style}>{category}</h2>
                <span style={categoryCountStyle}>
                  {features.length} Feature{features.length === 1 ? '' : 's'}
                </span>
              </header>
              <div style={cardGridStyle}>
                {features.map((f) => (
                  <CardWrap key={f.id} feature={f} />
                ))}
              </div>
            </section>
          );
        })}

        {/* ─── Footer-Notiz: ehrliche Recherche-Lücke ─────────────── */}
        <footer style={footerStyle}>
          <div style={footerLabelStyle}>Recherche-Lücke (ehrlich)</div>
          <p style={footerProseStyle}>
            Voice/Realtime-Tools (lib/voice/*, lib/realtime/*) und das volle
            GitHub-Integration-Substrat (lib/github/*) sind in diesem Katalog
            bewusst nicht eigen aufgeführt, weil die Recherche-Sweeps sie nur
            am Rand erfasst haben — sie laufen mehr als eigenständige Adapter
            denn als „on-top" Claude/Codex-Aufpfropfungen. Ebenso fehlen das
            Push/Notification-System und die Cron/Routines-Schicht aus dem
            gleichen Grund. Sie sind im Repo vorhanden (Verzeichnisse
            <code style={codeStyle}>lib/voice/</code>,
            <code style={codeStyle}>lib/realtime/</code>,
            <code style={codeStyle}>lib/github/</code>,
            <code style={codeStyle}>lib/push/</code>,
            <code style={codeStyle}>lib/routines/</code>) — eine zweite
            Recherche-Welle würde sie analog hier eintragen.
          </p>
        </footer>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// CardWrap — leichtgewichtiger Wrapper, der die data-* Attribute für den
// Client-Filter setzt. Trennt das vom render-only FeatureCard, damit dieses
// rein Markup bleibt.
// ---------------------------------------------------------------------------

function CardWrap({ feature }: { feature: Feature }): React.ReactElement {
  const searchHaystack = [
    feature.name,
    feature.category,
    feature.status,
    feature.onTop,
    feature.function,
    feature.mechanism,
    feature.improves,
    ...feature.useCases,
    ...(feature.refs.map((r) => `${r.label} ${r.path}`)),
    ...(feature.beforeAfter
      ? [feature.beforeAfter.before, feature.beforeAfter.after]
      : []),
    ...(feature.prosCons
      ? [...feature.prosCons.pros, ...feature.prosCons.cons]
      : []),
  ]
    .join(' ')
    .toLowerCase();
  return (
    <div
      data-feature-id={feature.id}
      data-category={feature.category}
      data-status={feature.status}
      data-ontop={feature.onTop}
      data-search={searchHaystack}
    >
      <FeatureCard feature={feature} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SummaryStat
// ---------------------------------------------------------------------------

function SummaryStat({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div style={summaryStatStyle}>
      <div style={summaryValueStyle}>{value}</div>
      <div style={summaryLabelStyle}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles (token-only)
// ---------------------------------------------------------------------------

const mainStyle: CSSProperties = {
  paddingTop: 24,
  paddingBottom: 80,
  paddingLeft: 16,
  paddingRight: 16,
};

const shellStyle: CSSProperties = {
  maxWidth: 1100,
  marginLeft: 'auto',
  marginRight: 'auto',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const eyebrowStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const h1Style: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 'clamp(32px, 6vw, 52px)',
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
};

const leadStyle: CSSProperties = {
  margin: 0,
  marginTop: 4,
  maxWidth: 740,
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--ink-2)',
};

const emStyle: CSSProperties = {
  fontStyle: 'italic',
  color: 'var(--ink)',
};

const summaryRowStyle: CSSProperties = {
  marginTop: 14,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
};

const summaryStatStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 12px',
  borderRadius: 10,
  border: '0.5px solid var(--line)',
  background: 'var(--sheet-3)',
  minWidth: 92,
};

const summaryValueStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
};

const summaryLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const navStyle: CSSProperties = {
  marginTop: 18,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  padding: 8,
  borderRadius: 12,
  border: '0.5px solid var(--line)',
  background: 'color-mix(in oklab, var(--sheet-2) 40%, transparent)',
};

const navItemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 'var(--radius-pill)',
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  textDecoration: 'none',
  letterSpacing: '0.04em',
  minHeight: 32,
};

const navCountStyle: CSSProperties = {
  fontSize: 10,
  color: 'var(--ink-3)',
  borderLeft: '0.5px solid var(--line)',
  paddingLeft: 8,
};

const emptyStateStyle: CSSProperties = {
  display: 'none',
  marginTop: 24,
  padding: 24,
  textAlign: 'center',
  borderRadius: 12,
  border: '0.5px dashed var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 40%, transparent)',
  color: 'var(--ink-3)',
  fontSize: 'var(--fs-body)',
};

const categorySectionStyle: CSSProperties = {
  marginTop: 36,
  scrollMarginTop: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const categoryHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  flexWrap: 'wrap',
};

const h2Style: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 'clamp(22px, 4vw, 28px)',
  fontWeight: 600,
  letterSpacing: '-0.015em',
  color: 'var(--ink)',
};

const categoryCountStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const cardGridStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  gridTemplateColumns: 'minmax(0, 1fr)',
};

const footerStyle: CSSProperties = {
  marginTop: 48,
  padding: 16,
  borderRadius: 12,
  border: '0.5px solid var(--line)',
  background: 'color-mix(in oklab, var(--sheet-2) 40%, transparent)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const footerLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const footerProseStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--ink-2)',
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '1px 5px',
  borderRadius: 4,
  background: 'var(--sheet-3)',
  border: '0.5px solid var(--line)',
  color: 'var(--ink-2)',
};
