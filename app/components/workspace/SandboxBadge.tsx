/**
 * SandboxBadge — Pill-Marker für Workspaces im Sandbox-Mode (P16, 2026-05-01).
 *
 * Visual:
 *   - Gepunktete Border (visuell „Spielfeld klar abgesteckt")
 *   - Kein Warnung-Icon — Sandbox ist Enabler, kein Gefahren-State
 *   - Gleiche Höhe + Mono-Font wie umliegende Status-Pills
 *
 * Nutzung:
 *   {workspace.sandboxMode === 1 ? <SandboxBadge /> : null}
 *
 * Surface-Library-konform: inline-style, keine Overlays, keine externen
 * CSS-Klassen.
 */

import type { CSSProperties, JSX } from 'react';

interface Props {
  /** Optional: kompakte Darstellung (kleiner, nur „SBX"). */
  compact?: boolean;
  /** Optional: aria-label / title-Override. */
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
