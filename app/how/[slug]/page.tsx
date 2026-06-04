/**
 * /how/[slug] — Sub-Page für ein lazyOS-Konzept.
 *
 * Bilingual via ?lang=de|en (Default: de). Stilistisch der Übersicht
 * angeglichen: Apple-Keynote, große Typo, viel Whitespace, fluide Units.
 *
 * Live-Stats (Hero-Number) optional pro Sub-Page — siehe `liveStat` im
 * Content-Modell. Reads sind defensiv: schlägt der Read fehl, wird die
 * Hero-Number ausgelassen statt die ganze Seite zum Crashen zu bringen.
 */

import type { CSSProperties, ReactNode } from 'react';
import { notFound } from 'next/navigation';

import {
  getSubPage,
  SLUGS,
  type Section as ContentSection,
  type SubPageContent,
} from '../../../lib/how/content';
import {
  altLocale,
  pickLocale,
  tr,
  UI_STRINGS,
  type Locale,
} from '../../../lib/how/locale';

export const dynamic = 'force-dynamic';

export function generateStaticParams() {
  return SLUGS.map((slug) => ({ slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HowSubPage(props: PageProps) {
  const { slug } = await props.params;
  const sp = await props.searchParams;
  const loc = pickLocale(sp.lang);

  const content = getSubPage(slug);
  if (!content) notFound();

  const stat = await loadLiveStat(content);

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <TopBar slug={slug} loc={loc} />
      <Hero loc={loc} content={content} stat={stat} />
      <Sections loc={loc} sections={content.sections} />
      <Related loc={loc} routes={content.relatedRoutes} />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Live-Stat (best-effort, optional)
// ---------------------------------------------------------------------------

async function loadLiveStat(
  content: SubPageContent,
): Promise<{ label: string; value: number } | null> {
  if (!content.liveStat) return null;
  try {
    if (content.liveStat.kind === 'skills') {
      const { listSkills } = await import('../../../lib/agents/skills/service');
      const all = listSkills(); // bereits ohne archivierte
      return { label: 'skills', value: all.length };
    }
    if (content.liveStat.kind === 'workspaces') {
      const { listWorkspaces } = await import('../../../lib/workspaces');
      const ws = await listWorkspaces();
      return { label: 'workspaces', value: ws.length };
    }
    if (content.liveStat.kind === 'sessions') {
      const { listClaudeSessions } = await import('../../../lib/sessions/registry');
      const ses = listClaudeSessions({ limit: 1000 });
      return { label: 'sessions', value: ses.length };
    }
  } catch {
    // best-effort — bei DB-Errors lieber Hero ohne Stat als 500
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-Bar (Back-Link + Locale-Toggle)
// ---------------------------------------------------------------------------

function TopBar(props: { slug: string; loc: Locale }) {
  const ui = UI_STRINGS[props.loc];
  const otherLoc = altLocale(props.loc);
  const otherHref = `/how/${props.slug}?lang=${otherLoc}`;
  const backHref = `/how?lang=${props.loc}`;

  return (
    <nav style={topBarStyle} aria-label="how-subnav">
      <a href={backHref} style={topBarLinkStyle}>
        <span aria-hidden="true">←</span>
        <span>{ui.backToHow}</span>
      </a>
      <a href={otherHref} style={topBarLangStyle}>
        <span style={{ opacity: 0.5 }}>{ui.languageSwitch}</span>
        <span style={topBarLangPillStyle(props.loc === 'de')}>DE</span>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <span style={topBarLangPillStyle(props.loc === 'en')}>EN</span>
      </a>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero(props: {
  loc: Locale;
  content: SubPageContent;
  stat: { label: string; value: number } | null;
}) {
  const ui = UI_STRINGS[props.loc];
  return (
    <header style={heroStyle}>
      <div className="t-kicker" style={kickerLineStyle}>
        <span style={{ width: 40, height: 1, background: 'var(--a-now)' }} />
        {props.content.slug.toUpperCase()} · {ui.overviewKicker}
      </div>
      <h1 className="t-display" style={{ maxWidth: 1000 }}>
        {tr(props.loc, props.content.title)}
      </h1>
      <p style={leadStyle}>{tr(props.loc, props.content.lead)}</p>

      {props.stat ? (
        <div style={heroStatStyle}>
          <span style={heroStatNumStyle}>{props.stat.value}</span>
          <span style={heroStatLabelStyle}>
            {ui.statLive} · {props.stat.label}
          </span>
        </div>
      ) : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Sections(props: { loc: Locale; sections: ContentSection[] }) {
  return (
    <div>
      {props.sections.map((s, i) => (
        <SectionView key={i} loc={props.loc} section={s} index={i} />
      ))}
    </div>
  );
}

function SectionView(props: {
  loc: Locale;
  section: ContentSection;
  index: number;
}) {
  const num = String(props.index + 1).padStart(2, '0');
  const heading = tr(props.loc, props.section.heading);
  const body = tr(props.loc, props.section.body);
  const bullets = props.section.bullets
    ? tr(props.loc, props.section.bullets)
    : null;

  return (
    <section style={sectionStyle}>
      <div className="t-kicker" style={kickerStyle}>
        {num} · {heading}
      </div>
      <h2 className="t-h2" style={{ maxWidth: 900, marginTop: 14 }}>
        {heading}
      </h2>
      <p style={leadStyle}>{body}</p>

      {bullets ? (
        <ul style={bulletListStyle}>
          {bullets.map((b, j) => (
            <li key={j} style={bulletItemStyle}>
              {b}
            </li>
          ))}
        </ul>
      ) : null}

      {props.section.code ? (
        <pre style={codeBlockStyle}>
          <code>{props.section.code}</code>
        </pre>
      ) : null}

      {props.section.surfaceTag ? (
        <div style={surfaceTagWrapStyle}>
          <span style={surfaceTagDotStyle} />
          <code style={surfaceTagCodeStyle}>
            &lt;surface:{props.section.surfaceTag}&gt;
          </code>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Related routes
// ---------------------------------------------------------------------------

function Related(props: {
  loc: Locale;
  routes: SubPageContent['relatedRoutes'];
}) {
  if (!props.routes.length) return null;
  const ui = UI_STRINGS[props.loc];
  return (
    <section style={{ ...sectionStyle, marginTop: 'clamp(64px, 8vw, 96px)' }}>
      <div className="t-kicker" style={kickerStyle}>
        ⤳ · {ui.related}
      </div>
      <div style={relatedGridStyle}>
        {props.routes.map((r) => (
          <a key={r.href} href={r.href} style={relatedCardStyle}>
            <span style={relatedCardLabelStyle}>{tr(props.loc, r.label)}</span>
            <span style={relatedCardHrefStyle}>{r.href}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

// ===========================================================================
// Styles
// ===========================================================================

const topBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  paddingTop: 'clamp(20px, 3vw, 36px)',
  marginBottom: 'clamp(20px, 3vw, 32px)',
  flexWrap: 'wrap',
};

const topBarLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  color: 'var(--ink-2)',
  textDecoration: 'none',
};

const topBarLangStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.04em',
  color: 'var(--ink-3)',
  textDecoration: 'none',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

function topBarLangPillStyle(active: boolean): CSSProperties {
  return {
    color: active ? 'var(--a-now)' : 'var(--ink-3)',
    fontWeight: active ? 600 : 400,
  };
}

const heroStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 'clamp(20px, 3vw, 40px)',
  marginBottom: 56,
};

const kickerLineStyle: CSSProperties = {
  color: 'var(--a-now)',
  marginBottom: 24,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const leadStyle: CSSProperties = {
  marginTop: 18,
  maxWidth: 720,
  fontSize: 'clamp(15px, 1.6vw, 17px)',
  lineHeight: 1.55,
  color: 'var(--ink-2)',
  letterSpacing: '-0.005em',
};

const heroStatStyle: CSSProperties = {
  marginTop: 36,
  display: 'inline-flex',
  alignItems: 'baseline',
  gap: 12,
  padding: '12px 18px',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const heroStatNumStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'clamp(28px, 4vw, 40px)',
  fontWeight: 600,
  color: 'var(--ink)',
  letterSpacing: '-0.02em',
  lineHeight: 1,
};

const heroStatLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const sectionStyle: CSSProperties = {
  maxWidth: 1100,
  marginTop: 'clamp(48px, 7vw, 96px)',
};

const kickerStyle: CSSProperties = {
  color: 'var(--a-now)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const bulletListStyle: CSSProperties = {
  marginTop: 18,
  paddingLeft: 0,
  maxWidth: 720,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const bulletItemStyle: CSSProperties = {
  position: 'relative',
  paddingLeft: 22,
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--ink-2)',
  letterSpacing: '-0.005em',
  // Custom bullet via background marker
  backgroundImage:
    'radial-gradient(circle at 4px 9px, var(--a-now) 2.5px, transparent 3px)',
  backgroundRepeat: 'no-repeat',
};

const codeBlockStyle: CSSProperties = {
  marginTop: 22,
  padding: '16px 18px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 90%, transparent)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-2)',
  overflowX: 'auto',
  lineHeight: 1.6,
};

const surfaceTagWrapStyle: CSSProperties = {
  marginTop: 18,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 12px',
  borderRadius: 999,
  border: '0.5px solid color-mix(in srgb, var(--a-now) 30%, var(--line-2))',
  background: 'color-mix(in srgb, var(--a-now) 6%, transparent)',
};

const surfaceTagDotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: 999,
  background: 'var(--a-now)',
};

const surfaceTagCodeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  letterSpacing: '0.02em',
};

const relatedGridStyle: CSSProperties = {
  marginTop: 24,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 12,
};

const relatedCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '16px 18px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
  textDecoration: 'none',
};

const relatedCardLabelStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
};

const relatedCardHrefStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--a-now)',
  letterSpacing: '0.02em',
};
