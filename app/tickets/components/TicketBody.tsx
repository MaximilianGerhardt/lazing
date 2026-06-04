'use client';

/**
 * TicketBody — Apple-Keynote-style expandable description.
 *
 * Default: 1-2 sentences (~180 characters) as a lead, subtle. Clicking
 * "Mehr lesen" expands to the full text with large typography + whitespace.
 * Markdown is rendered as pre-wrap plain text (no react-markdown
 * because of bundle size; swap later if needed).
 */

import { useState, type CSSProperties } from 'react';

const PREVIEW_LIMIT = 180;

export function TicketBody({ body }: { body: string | undefined }) {
  const [expanded, setExpanded] = useState(false);

  if (!body || body.trim().length === 0) {
    return (
      <p style={emptyStyle}>Keine Beschreibung.</p>
    );
  }

  const trimmed = body.trim();
  const isLong = trimmed.length > PREVIEW_LIMIT;
  const preview = isLong
    ? trimmed.slice(0, PREVIEW_LIMIT).replace(/\s+\S*$/, '') + '…'
    : trimmed;

  return (
    <article style={wrapStyle}>
      {expanded || !isLong ? (
        <div style={fullBodyStyle}>{trimmed}</div>
      ) : (
        <div style={previewStyle}>{preview}</div>
      )}
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={toggleBtnStyle}
          aria-expanded={expanded}
        >
          {expanded ? 'Weniger' : 'Mehr lesen'}
        </button>
      ) : null}
    </article>
  );
}

const wrapStyle: CSSProperties = {
  marginTop: 14,
  padding: 'clamp(20px, 3vw, 32px) clamp(20px, 3vw, 36px)',
  borderRadius: 18,
  background: 'color-mix(in oklab, var(--sheet-2) 92%, transparent)',
  border: '0.5px solid var(--line-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const previewStyle: CSSProperties = {
  fontSize: 'clamp(15px, 1.6vw, 18px)',
  lineHeight: 1.5,
  letterSpacing: '-0.01em',
  color: 'var(--ink-1, var(--ink))',
  whiteSpace: 'pre-wrap',
};

const fullBodyStyle: CSSProperties = {
  fontSize: 'clamp(14px, 1.5vw, 16px)',
  lineHeight: 1.65,
  letterSpacing: '-0.005em',
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
};

const toggleBtnStyle: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '4px 12px',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'transparent',
  color: 'var(--a-now)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  cursor: 'pointer',
};

const emptyStyle: CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: 'var(--ink-3)',
  fontStyle: 'italic',
};
