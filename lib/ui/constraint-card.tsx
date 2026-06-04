/**
 * EnablerCard — constraint-as-enabler reframing (P15, 2026-05-01).
 * ----------------------------------------------------------------
 *
 * Anne (Legaly-AI, quote): „Compliance wird heute als Bottleneck, als Bremse
 * wahrgenommen in Unternehmen. Am Ende könnte man es auch als Enabler sehen."
 *
 * Reframing principle:
 *   - A critic finding / sensitivity gate / reviewer hint is NOT an
 *     error. It is a lever: "this requirement opens up <X> for you".
 *   - Visual language: blue (info) / green (opportunity) / yellow (gate).
 *     NO red, NO error icon.
 *
 * Severities:
 *   - 'info'        — neutral observation, no action needed
 *   - 'opportunity' — lever: if fixed → trust/reach gain
 *   - 'gate'        — must be addressed, but as a gate (not a wall)
 *
 * Headline format: "this requirement opens up <consequence> for you".
 * Body: optional "if satisfied: <trustScoreImpact>".
 *
 * Surface-Library-compliant: inline style, no overlays, no modals.
 */

import type { CSSProperties, JSX } from 'react';

export type EnablerSeverity = 'info' | 'opportunity' | 'gate';

export interface EnablerCardProps {
  /** What was found — short sentence, max. 240 characters. */
  finding: string;
  /** What opens up when the finding is addressed. */
  consequence: string;
  /** Optional: numeric trust-score impact (rendered with "+X Trust"). */
  trustScoreImpact?: number;
  severity: EnablerSeverity;
  /** Optional: source (e.g. "critic", "compliance-advisor", "sensitivity"). */
  source?: string;
  /** Optional: additional body hint. */
  hint?: string;
}

interface Palette {
  fg: string;
  bg: string;
  border: string;
  pillFg: string;
  pillBg: string;
}

const PALETTES: Record<EnablerSeverity, Palette> = {
  info: {
    fg: 'var(--ink)',
    bg: 'color-mix(in oklab, #2563eb 6%, var(--sheet))',
    border: 'color-mix(in oklab, #2563eb 30%, var(--line-2))',
    pillFg: '#1d4ed8',
    pillBg: 'color-mix(in oklab, #2563eb 14%, var(--sheet))',
  },
  opportunity: {
    fg: 'var(--ink)',
    bg: 'color-mix(in oklab, #1f9d55 6%, var(--sheet))',
    border: 'color-mix(in oklab, #1f9d55 30%, var(--line-2))',
    pillFg: '#15803d',
    pillBg: 'color-mix(in oklab, #1f9d55 14%, var(--sheet))',
  },
  gate: {
    fg: 'var(--ink)',
    bg: 'color-mix(in oklab, #c98a00 6%, var(--sheet))',
    border: 'color-mix(in oklab, #c98a00 30%, var(--line-2))',
    pillFg: '#a16207',
    pillBg: 'color-mix(in oklab, #c98a00 14%, var(--sheet))',
  },
};

const SEVERITY_LABEL: Record<EnablerSeverity, string> = {
  info: 'Hinweis',
  opportunity: 'Hebel',
  gate: 'Quality-Gate',
};

export function EnablerCard(props: EnablerCardProps): JSX.Element {
  const palette = PALETTES[props.severity];

  return (
    <section
      role="note"
      aria-label={`${SEVERITY_LABEL[props.severity]}: ${props.consequence}`}
      data-severity={props.severity}
      style={{
        ...cardBase,
        background: palette.bg,
        borderColor: palette.border,
        color: palette.fg,
      }}
    >
      <header style={headerStyle}>
        <span
          style={{
            ...pillStyle,
            color: palette.pillFg,
            background: palette.pillBg,
            borderColor: palette.border,
          }}
        >
          {SEVERITY_LABEL[props.severity]}
        </span>
        {props.source ? <span style={sourceStyle}>{props.source}</span> : null}
      </header>

      <h3 style={headlineStyle}>
        Diese Auflage öffnet dir {props.consequence}
      </h3>

      <p style={findingStyle}>{props.finding}</p>

      {typeof props.trustScoreImpact === 'number' &&
      Number.isFinite(props.trustScoreImpact) ? (
        <p style={impactStyle}>
          <span style={impactPillStyle}>
            {props.trustScoreImpact >= 0 ? '+' : ''}
            {props.trustScoreImpact} Trust
          </span>
          <span>Wenn erfüllt</span>
        </p>
      ) : null}

      {props.hint ? <p style={hintStyle}>{props.hint}</p> : null}
    </section>
  );
}

// ────────────────────────────── Styles ──────────────────────────────

const cardBase: CSSProperties = {
  marginTop: 12,
  padding: 'clamp(14px, 2vw, 20px)',
  borderRadius: 12,
  borderWidth: 1,
  borderStyle: 'solid',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 760,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const pillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '2px 10px',
  borderRadius: 999,
  borderWidth: 1,
  borderStyle: 'solid',
};

const sourceStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.04em',
};

const headlineStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: 1.4,
  letterSpacing: '-0.005em',
  fontWeight: 600,
};

const findingStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--ink-2)',
};

const impactStyle: CSSProperties = {
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  color: 'var(--ink-2)',
};

const impactPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontVariantNumeric: 'tabular-nums',
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--sheet)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--ink-3)',
  fontStyle: 'italic',
};
