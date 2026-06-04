'use client';

/**
 * BrandingShowcase — visual impression of the current token stack per
 * workspace. Shows accent palette, font stack, buttons, inputs, cards,
 * pills, code blocks. Style: 1:1 like /design.
 *
 * Phase B (workspace branding) will make this interactive: accent picker,
 * font-pair selector etc. FOR NOW just a read-only showcase that renders
 * the live tokens of the current workspace.
 */

import type { CSSProperties } from 'react';

interface Props {
  workspaceId: string;
  label: string;
  accent: string;
}

const ACCENT_TO_TOKEN: Record<string, string> = {
  north: 'var(--a-north)',
  clientb: 'var(--a-clientb)',
  own: 'var(--a-own)',
  private: 'var(--a-private)',
};

export function BrandingShowcase({ workspaceId, label, accent }: Props) {
  const accentToken = ACCENT_TO_TOKEN[accent] ?? 'var(--a-now)';

  return (
    <div style={wrapStyle}>
      <SectionHeader
        kicker="01 · Akzentfarbe"
        title="Was diesen Workspace visuell unterscheidet."
        sub="Die primäre Akzentfarbe taucht in CTAs, aktiven States, Pipeline-Glows auf."
      />

      <div style={accentRowStyle}>
        <div style={accentBlockStyle(accentToken)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <code style={tokenStyle}>
            --a-now → var(--a-{accent})
          </code>
          <span style={metaStyle}>
            Aktuell: <strong style={{ color: 'var(--ink)' }}>{accent}</strong>
          </span>
        </div>
      </div>

      <SectionHeader
        kicker="02 · Sheet-Farbpalette"
        title="Pitch-Black-Stack."
        sub="Dunkelste Schicht (sheet) bis hellste Tinte (ink). Jede Komponente referenziert nur Tokens."
      />
      <div style={swatchGridStyle}>
        <Swatch token="--sheet" label="sheet" />
        <Swatch token="--sheet-2" label="sheet-2" />
        <Swatch token="--sheet-3" label="sheet-3" />
        <Swatch token="--ink-4" label="ink-4" />
        <Swatch token="--ink-3" label="ink-3" />
        <Swatch token="--ink-2" label="ink-2" />
        <Swatch token="--ink" label="ink" />
        <Swatch token="--primary" label="primary" />
      </div>

      <SectionHeader
        kicker="03 · Semantische Farben"
        title="Status & Engines."
        sub="Werden für Erfolg, Warnung, Fehler und Engine-Identifikation genutzt."
      />
      <div style={swatchGridStyle}>
        <Swatch token="--a-clientb" label="success" />
        <Swatch token="--a-warn" label="warn" />
        <Swatch token="--a-danger" label="danger" />
        <Swatch token="--e-claude" label="engine·claude" />
        <Swatch token="--e-codex" label="engine·codex" />
        <Swatch token="--e-local" label="engine·local" />
      </div>

      <SectionHeader
        kicker="04 · Typografie"
        title="Drei Font-Stacks."
        sub="Display für Headlines, Sans für Body, Mono für Code + Meta."
      />
      <div style={typoGridStyle}>
        <div style={typoCardStyle}>
          <code style={tokenStyle}>--font-display</code>
          <div style={{ ...typoSampleStyle, fontFamily: 'var(--font-display)', fontSize: 'clamp(28px, 4vw, 44px)', fontWeight: 600, letterSpacing: '-0.035em' }}>
            {label}
          </div>
          <span style={metaStyle}>SF Pro Display · Headlines</span>
        </div>
        <div style={typoCardStyle}>
          <code style={tokenStyle}>--font-sans</code>
          <div style={{ ...typoSampleStyle, fontFamily: 'var(--font-sans)', fontSize: 16, letterSpacing: '-0.005em', lineHeight: 1.55 }}>
            Body-Text wird in San Francisco gesetzt — kompakt, lesbar, mit
            negativem Letter-Spacing für die Apple-Sprache.
          </div>
          <span style={metaStyle}>SF Pro Text · Body</span>
        </div>
        <div style={typoCardStyle}>
          <code style={tokenStyle}>--font-mono</code>
          <div style={{ ...typoSampleStyle, fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '-0.01em' }}>
            workspace_id = &quot;{workspaceId}&quot;
            <br />
            sessionId = ulid()
          </div>
          <span style={metaStyle}>SF Mono · Code + Meta</span>
        </div>
      </div>

      <SectionHeader
        kicker="05 · Komponenten"
        title="Wie Tokens als UI aussehen."
        sub="Alle Beispiele rendern gegen den aktuellen Token-Stack — was du hier siehst, sieht der User in jedem Workspace dieser Akzentfarbe."
      />
      <div style={componentsGridStyle}>
        <ComponentCard title="Pill">
          <span style={{ ...pillStyle, color: accentToken, borderColor: accentToken }}>
            {accent} · pill
          </span>
        </ComponentCard>

        <ComponentCard title="Primary-Button">
          <button type="button" style={{ ...primaryBtnStyle, background: accentToken }}>
            Aktion ausführen
          </button>
        </ComponentCard>

        <ComponentCard title="Secondary-Button">
          <button type="button" style={secondaryBtnStyle}>
            Abbrechen
          </button>
        </ComponentCard>

        <ComponentCard title="Input">
          <input
            type="text"
            placeholder="Tippe etwas …"
            style={inputStyle}
            readOnly
            value="Beispieltext"
          />
        </ComponentCard>

        <ComponentCard title="Card">
          <div style={cardSampleStyle}>
            <div style={{ ...metaStyle, color: accentToken }}>KICKER</div>
            <div style={{ fontSize: 15, fontWeight: 500, color: 'var(--ink)' }}>
              {label}
            </div>
            <p style={{ fontSize: 13, color: 'var(--ink-2)', margin: 0, lineHeight: 1.5 }}>
              Card-Komponente — passt sich an die Akzentfarbe des Workspaces an.
            </p>
          </div>
        </ComponentCard>

        <ComponentCard title="Code-Block">
          <pre style={codeBlockStyle}>
            <code>{`POST /api/workstreams\n{ "workspaceId": "${workspaceId}" }`}</code>
          </pre>
        </ComponentCard>
      </div>

      <SectionHeader
        kicker="06 · Konsistenz-Checkliste"
        title="Was Phase B (Branding) händeln muss."
        sub="Wenn Akzent / Logo / Schrift geändert werden, müssen diese Stellen automatisch mitziehen — sonst entsteht Drift."
      />
      <ul style={checkListStyle}>
        <Check item="TopNav-Akzent (Workspace-Pill, AutoMode-Toggle, aktiver Nav-Link)" />
        <Check item="Chat-User-Bubble (Background = Akzent)" />
        <Check item="Tier-Choice-Card (recommended-Border, Tier-Chips)" />
        <Check item="LiveWorkflowSurface aktive Pipeline-Stufe" />
        <Check item="MilestoneCard Headline-Glow" />
        <Check item="WorkspacePill auf /tickets, /workstreams, /lanes-Redirect" />
        <Check item="Push-Notification-Badge-Farbe (icon-192, badge-Token)" />
      </ul>
    </div>
  );
}

function SectionHeader({
  kicker,
  title,
  sub,
}: {
  kicker: string;
  title: string;
  sub?: string;
}) {
  return (
    <div style={sectionHeaderStyle}>
      <div className="t-kicker" style={kickerStyle}>
        <span style={{ width: 30, height: 1, background: 'var(--a-now)' }} />
        {kicker}
      </div>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {sub ? <p style={sectionSubStyle}>{sub}</p> : null}
    </div>
  );
}

function Swatch({ token, label }: { token: string; label: string }) {
  return (
    <div style={swatchStyle}>
      <div style={{ ...swatchBlockStyle, background: `var(${token})` }} />
      <code style={tokenStyle}>{token}</code>
      <span style={metaStyle}>{label}</span>
    </div>
  );
}

function ComponentCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={componentCardStyle}>
      <span style={metaStyle}>{title}</span>
      <div style={componentSampleStyle}>{children}</div>
    </div>
  );
}

function Check({ item }: { item: string }) {
  return (
    <li style={checkItemStyle}>
      <span style={checkBulletStyle}>◦</span>
      <span>{item}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'clamp(36px, 6vw, 64px)',
};

const sectionHeaderStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const kickerStyle: CSSProperties = {
  color: 'var(--a-now)',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 'clamp(20px, 2.6vw, 28px)',
  fontWeight: 500,
  letterSpacing: '-0.02em',
  color: 'var(--ink)',
  margin: 0,
};

const sectionSubStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
  maxWidth: 720,
};

const accentRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 24,
  flexWrap: 'wrap',
};

function accentBlockStyle(color: string): CSSProperties {
  return {
    width: 120,
    height: 120,
    borderRadius: 18,
    background: color,
    boxShadow: `0 0 60px color-mix(in srgb, ${color} 40%, transparent)`,
  };
}

const swatchGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 14,
};

const swatchStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 12,
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const swatchBlockStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '2 / 1',
  borderRadius: 8,
  border: '0.5px solid var(--line-2)',
};

const tokenStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  letterSpacing: '0.02em',
};

const metaStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const typoGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 16,
};

const typoCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: 'clamp(18px, 2.5vw, 28px)',
  borderRadius: 16,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const typoSampleStyle: CSSProperties = {
  color: 'var(--ink)',
};

const componentsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 14,
};

const componentCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: 18,
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 80%, transparent)',
};

const componentSampleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: 70,
  padding: 16,
  borderRadius: 10,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
};

const pillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  padding: '4px 12px',
  borderRadius: 999,
  border: '0.5px solid',
};

const primaryBtnStyle: CSSProperties = {
  padding: '10px 20px',
  borderRadius: 12,
  border: 'none',
  color: 'var(--sheet)',
  fontSize: 14,
  fontWeight: 500,
  letterSpacing: '-0.005em',
  cursor: 'default',
};

const secondaryBtnStyle: CSSProperties = {
  padding: '10px 20px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--ink-2)',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'default',
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  borderRadius: 10,
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 14,
  fontFamily: 'var(--font-sans)',
};

const cardSampleStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 14,
  borderRadius: 10,
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  width: '100%',
};

const codeBlockStyle: CSSProperties = {
  margin: 0,
  padding: '10px 14px',
  borderRadius: 8,
  background: 'var(--sheet-3)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink)',
  overflowX: 'auto',
  whiteSpace: 'pre',
  width: '100%',
};

const checkListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const checkItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  fontSize: 14,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
};

const checkBulletStyle: CSSProperties = {
  color: 'var(--a-now)',
  fontFamily: 'var(--font-mono)',
};
