'use client';

import type { CSSProperties, ReactNode } from 'react';

import { IconClose } from '../../nav/icons';

interface MsgSystemProps {
  /**
   * Kind / Event-Type label (e.g. "approval · tickets", "heartbeat", "routine").
   */
  kind: string;
  /** Relative time string (z.B. "14:32", "vor 2 min"). */
  ts?: string;
  /** Severity color-hint. */
  severity?: 'info' | 'warn' | 'critical';
  /** Main content — typically a rendered Surface-Card. */
  children: ReactNode;
  /** If provided, shows a -dismiss button. */
  onDismiss?: () => void;
  /** If provided, clicking the row navigates to href. */
  href?: string;
}

/**
 * CHT — System-Message (Event from Live-Stream).
 *
 * Dezenter als MsgAssistant, links-ausgerichtet, mit kleinem
 * Header "System · <kind> · <ts>" und optionalem Dismiss-.
 * Severity steuert Akzent-Farbe (info: ink-3, warn: a-warn, critical: a-danger).
 */
export function MsgSystem({
  kind,
  ts,
  severity = 'info',
  children,
  onDismiss,
  href,
}: MsgSystemProps) {
  const accent =
    severity === 'critical'
      ? 'var(--a-danger)'
      : severity === 'warn'
        ? 'var(--a-warn)'
        : 'var(--ink-3)';

  return (
    <div
      className="msg-system"
      role="article"
      aria-label={`System-Benachrichtigung ${kind}`}
      style={wrapStyle}
    >
      <div style={headerStyle}>
        <span
          aria-hidden="true"
          style={{ ...dotStyle, background: accent }}
        />
        <span style={kindStyle}>System · {kind}</span>
        {ts ? <span style={tsStyle}>· {ts}</span> : null}
        {href ? (
          <a href={href} style={linkStyle}>
            Öffnen →
          </a>
        ) : null}
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Benachrichtigung entfernen"
            style={dismissStyle}
          >
            <IconClose size={14} />
          </button>
        ) : null}
      </div>
      <div style={bodyStyle}>{children}</div>
    </div>
  );
}

const wrapStyle: CSSProperties = {
  maxWidth: 520,
  margin: '12px 0',
  padding: '10px 14px',
  borderRadius: 12,
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
  border: '0.5px solid var(--line-2)',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  letterSpacing: '0.02em',
  color: 'var(--ink-3)',
  marginBottom: 6,
};

const dotStyle: CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: '50%',
  display: 'inline-block',
};

const kindStyle: CSSProperties = {
  color: 'var(--ink-2)',
};

const tsStyle: CSSProperties = {
  color: 'var(--ink-4)',
};

const linkStyle: CSSProperties = {
  marginLeft: 'auto',
  color: 'var(--ink-2)',
  textDecoration: 'none',
  fontSize: 11,
};

const dismissStyle: CSSProperties = {
  marginLeft: 8,
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-4)',
  cursor: 'pointer',
  fontSize: 12,
  padding: '2px 6px',
  borderRadius: 4,
  fontFamily: 'inherit',
};

const bodyStyle: CSSProperties = {
  color: 'var(--ink-1, var(--ink))',
  fontSize: 14,
  lineHeight: 1.5,
};
