// SPDX-License-Identifier: GPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Maximilian Gerhardt
//
// app/features/_components/FeatureCard — Server-Component, render-only.
//
// Token-only Farben (var(--…)) gemäss laz.ing Design Manifest v1.0:
//   Pitch-Black Canvas + SF Pro Display (--font-display) + 0.5px Lines.
// KEINE neuen Hex-Werte. KEIN shadcn. Mobile-first: 375px-tauglich,
// Card-Padding 16px, Pills wrap, Refs als kleine Mono-Pills.

import type { CSSProperties } from 'react';

import type { Feature, FeatureStatus, FeatureOnTop } from '@/lib/features/catalog';

const STATUS_TOKENS: Record<
  FeatureStatus,
  { fg: string; bg: string; label: string }
> = {
  live: { fg: 'var(--a-clientb)', bg: 'var(--a-clientb)', label: 'Live' },
  'owner-gated': { fg: 'var(--a-warn)', bg: 'var(--a-warn)', label: 'Owner-Gated' },
  dev: { fg: 'var(--a-private)', bg: 'var(--a-private)', label: 'Dev' },
  planned: { fg: 'var(--ink-3)', bg: 'var(--ink-3)', label: 'Planned' },
  deferred: { fg: 'var(--ink-4)', bg: 'var(--ink-4)', label: 'Deferred' },
};

const ONTOP_TOKENS: Record<FeatureOnTop, { fg: string; label: string }> = {
  'claude-code': { fg: 'var(--e-claude)', label: 'on Claude Code' },
  codex: { fg: 'var(--e-codex)', label: 'on Codex' },
  both: { fg: 'var(--ink)', label: 'on Claude + Codex' },
  standalone: { fg: 'var(--ink-3)', label: 'standalone' },
};

export function FeatureCard({ feature }: { feature: Feature }): React.ReactElement {
  const st = STATUS_TOKENS[feature.status];
  const ot = ONTOP_TOKENS[feature.onTop];
  return (
    <article id={`feature-${feature.id}`} style={cardStyle}>
      <header style={cardHeaderStyle}>
        <h3 style={titleStyle}>{feature.name}</h3>
        <div style={pillRowStyle}>
          <StatusPill label={st.label} fg={st.fg} bg={st.bg} />
          <OnTopPill label={ot.label} fg={ot.fg} />
          <CategoryPill label={feature.category} />
        </div>
      </header>

      <Section label="Funktion">
        <p style={proseStyle}>{feature.function}</p>
      </Section>

      <Section label="Mechanik">
        <p style={proseStyle}>{feature.mechanism}</p>
      </Section>

      <Section label="Verbesserung">
        <p style={proseStyle}>{feature.improves}</p>
      </Section>

      {feature.useCases.length > 0 && (
        <Section label="Use-Cases">
          <ul style={useCasesStyle}>
            {feature.useCases.map((u, i) => (
              <li key={i} style={useCaseItemStyle}>
                <span style={useCaseDotStyle} aria-hidden="true" />
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {feature.beforeAfter && (
        <Section label="Vorher / Nachher">
          <div style={baGridStyle}>
            <div style={baColStyle}>
              <div style={baHeadStyle('var(--ink-3)')}>Vorher</div>
              <p style={baBodyStyle}>{feature.beforeAfter.before}</p>
            </div>
            <div style={baColStyle}>
              <div style={baHeadStyle('var(--a-clientb)')}>Nachher</div>
              <p style={baBodyStyle}>{feature.beforeAfter.after}</p>
            </div>
          </div>
        </Section>
      )}

      {feature.prosCons && (
        <Section label="Pro / Kontra">
          <div style={baGridStyle}>
            <div style={baColStyle}>
              <div style={baHeadStyle('var(--a-clientb)')}>Pro</div>
              <ul style={pcListStyle}>
                {feature.prosCons.pros.map((p, i) => (
                  <li key={i} style={pcItemStyle}>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div style={baColStyle}>
              <div style={baHeadStyle('var(--a-warn)')}>Kontra</div>
              <ul style={pcListStyle}>
                {feature.prosCons.cons.map((c, i) => (
                  <li key={i} style={pcItemStyle}>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Section>
      )}

      {feature.refs.length > 0 && (
        <Section label="Referenzen">
          <div style={refRowStyle}>
            {feature.refs.map((r, i) => (
              <span key={i} style={refPillStyle} title={r.path}>
                <span style={refLabelStyle}>{r.label}</span>
                <span style={refPathStyle}>{r.path}</span>
              </span>
            ))}
          </div>
        </Section>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Sub-pieces
// ---------------------------------------------------------------------------

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section style={sectionStyle}>
      <div style={sectionLabelStyle}>{label}</div>
      {children}
    </section>
  );
}

function StatusPill({
  label,
  fg,
  bg,
}: {
  label: string;
  fg: string;
  bg: string;
}): React.ReactElement {
  return (
    <span
      style={{
        ...basePillStyle,
        color: fg,
        background: `color-mix(in oklab, ${bg} 14%, transparent)`,
        borderColor: `color-mix(in oklab, ${fg} 40%, transparent)`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: fg,
          display: 'inline-block',
        }}
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

function OnTopPill({ label, fg }: { label: string; fg: string }): React.ReactElement {
  return (
    <span
      style={{
        ...basePillStyle,
        color: fg,
        background: 'transparent',
        borderColor: 'var(--line-2)',
      }}
    >
      {label}
    </span>
  );
}

function CategoryPill({ label }: { label: string }): React.ReactElement {
  return (
    <span
      style={{
        ...basePillStyle,
        color: 'var(--ink-2)',
        background: 'var(--sheet-3)',
        borderColor: 'var(--line)',
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Styles (token-only)
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 16,
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 'clamp(16px, 2.6vw, 19px)',
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
};

const pillRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
};

const basePillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  padding: '4px 9px',
  borderRadius: 'var(--radius-pill)',
  border: '0.5px solid var(--line-2)',
  whiteSpace: 'nowrap',
  minHeight: 22,
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const sectionLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};

const proseStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--ink-2)',
};

const useCasesStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const useCaseItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--ink-2)',
};

const useCaseDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 4,
  height: 4,
  borderRadius: 999,
  background: 'var(--ink-3)',
  marginTop: 9,
  flex: '0 0 auto',
};

const baGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 10,
};

const baColStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 12,
  borderRadius: 10,
  border: '0.5px solid var(--line)',
  background: 'var(--sheet-3)',
};

function baHeadStyle(color: string): CSSProperties {
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color,
  };
}

const baBodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--ink-2)',
};

const pcListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const pcItemStyle: CSSProperties = {
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-body)',
  color: 'var(--ink-2)',
};

const refRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const refPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 9px',
  borderRadius: 6,
  border: '0.5px solid var(--line)',
  background: 'var(--sheet-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-2)',
  maxWidth: '100%',
};

const refLabelStyle: CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 220,
};

const refPathStyle: CSSProperties = {
  color: 'var(--ink-3)',
  borderLeft: '0.5px solid var(--line)',
  paddingLeft: 8,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 240,
};
