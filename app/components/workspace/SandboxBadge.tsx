/**
 * SandboxBadge — pill marker for workspaces in sandbox mode (P16, 2026-05-01).
 *
 * Visual:
 *   - dotted border (visually "playing field clearly staked out")
 *   - no warning icon — sandbox is an enabler, not a danger state
 *   - same height + mono font as surrounding status pills
 *
 * Usage:
 *   {workspace.sandboxMode === 1 ? <SandboxBadge /> : null}
 *
 * Surface-library-conformant: inline style, no overlays, no external
 * CSS classes.
 */

import type { CSSProperties, JSX } from 'react';

interface Props {
  /** Optional: compact rendering (smaller, only "SBX"). */
  compact?: boolean;
  /** Optional: aria-label / title override. */
  title?: string;
}

const DEFAULT_TITLE =
  'Sandbox-Mode: Auto-Approve aktiv, Routine-Pushes unterdrückt. ' +
  'Loop-Guard und Credential-Gates bleiben aktiv.';

export function SandboxBadge({
  compact = false,
  title = DEFAULT_TITLE,
}: Props): JSX.Element {
  return (
    <span
      role="status"
      aria-label={title}
      title={title}
      style={compact ? compactStyle : badgeStyle}
    >
      {compact ? 'SBX' : 'Sandbox'}
    </span>
  );
}

const badgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  padding: '2px 10px',
  borderRadius: 999,
  border: '1px dotted var(--ink-3)',
  color: 'var(--ink-2)',
  background: 'transparent',
  lineHeight: 1.4,
};

const compactStyle: CSSProperties = {
  ...badgeStyle,
  fontSize: 9,
  padding: '1px 6px',
  letterSpacing: '0.06em',
};
