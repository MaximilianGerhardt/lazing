/**
 * WorkflowCard — Apple-Pure, Token-only.
 *
 * Pattern 4 Welle 2.2 (2026-05-01).
 *
 * Server-renderable (no 'use client'). Mount animation via `srf-pop` from
 * the global Surface tokens. Hover/press effects via CSS classes.
 *
 * Stubs (isStub=true) are visually dimmed + "Coming Soon" badge,
 * no start CTA.
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';

interface WorkflowCardProps {
  workflowId: string;
  label: string;
  description: string;
  version: string;
  stateCount: number;
  triggerHints: ReadonlyArray<string>;
  isStub: boolean;
  deprecated: boolean;
  activeRunCount?: number;
}

export function WorkflowCard(props: WorkflowCardProps): React.JSX.Element {
  const href = `/workflows/${encodeURIComponent(props.workflowId)}`;
  return (
    <article className="srf-pop wfc" style={cardStyle(props.isStub)}>
      <header style={headerStyle}>
        <h3 style={titleStyle}>{props.label}</h3>
        <span style={versionPillStyle}>{props.version}</span>
        {props.deprecated ? (
          <span style={deprecatedPillStyle}>deprecated</span>
        ) : null}
        {props.isStub ? (
          <span style={stubPillStyle}>Coming Soon</span>
        ) : null}
      </header>

      <p style={descStyle}>{props.description}</p>

      <dl style={metaStyle}>
        <div style={metaRowStyle}>
          <dt style={metaKeyStyle}>States</dt>
          <dd style={metaValStyle}>{props.stateCount}</dd>
        </div>
        <div style={metaRowStyle}>
          <dt style={metaKeyStyle}>Aktive Runs</dt>
          <dd style={metaValStyle}>{props.activeRunCount ?? 0}</dd>
        </div>
      </dl>

      {props.triggerHints.length > 0 ? (
        <ul style={hintsStyle}>
          {props.triggerHints.slice(0, 4).map((h) => (
            <li key={h} style={hintPillStyle}>
              {h}
            </li>
          ))}
        </ul>
      ) : null}

      <div style={ctaRowStyle}>
        <Link href={href} className="wfc-cta" style={ctaStyle(props.isStub)}>
          {props.isStub ? 'Vorschau' : 'Öffnen'}
        </Link>
      </div>
    </article>
  );
}

// --------------------------------------------------------------------------
// Styles — Tokens-only.
// --------------------------------------------------------------------------

function cardStyle(isStub: boolean): CSSProperties {
  return {
    padding: '20px 22px',
    borderRadius: 'var(--radius-lg, 16px)',
    border: '0.5px solid var(--line-2)',
    background: isStub
      ? 'color-mix(in oklab, var(--sheet-2) 40%, transparent)'
      : 'var(--sheet-2)',
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    minWidth: 0,
    opacity: isStub ? 0.78 : 1,
  };
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const titleStyle: CSSProperties = {
  fontSize: 17,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  margin: 0,
  flex: '1 1 auto',
  minWidth: 0,
};

const versionPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  padding: '2px 6px',
  borderRadius: 4,
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink-3)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

const stubPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--ink-3) 14%, transparent)',
  color: 'var(--ink-3)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const deprecatedPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  padding: '2px 6px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--a-warn, #c08) 16%, transparent)',
  color: 'var(--a-warn, #c08)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const descStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-2)',
  lineHeight: 1.55,
  margin: 0,
};

const metaStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
  margin: 0,
};

const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const metaKeyStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  margin: 0,
};

const metaValStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 500,
  color: 'var(--ink)',
  margin: 0,
  fontVariantNumeric: 'tabular-nums',
};

const hintsStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

const hintPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  padding: '2px 7px',
  borderRadius: 999,
  background: 'var(--sheet-3, var(--sheet-2))',
  color: 'var(--ink-3)',
  letterSpacing: '0.02em',
};

const ctaRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: 4,
};

function ctaStyle(isStub: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 14px',
    fontSize: 13,
    fontWeight: 500,
    color: isStub ? 'var(--ink-3)' : 'var(--ink)',
    background: isStub
      ? 'color-mix(in oklab, var(--sheet-3, var(--sheet-2)) 60%, transparent)'
      : 'var(--sheet-3, var(--sheet-2))',
    border: '0.5px solid var(--line-2)',
    borderRadius: 'var(--radius-md, 10px)',
    textDecoration: 'none',
    transition: 'transform 120ms var(--spring-bouncy, ease)',
  };
}
