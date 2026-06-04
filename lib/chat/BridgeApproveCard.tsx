'use client';

/**
 * BridgeApproveCard — the cross-scope approve moment.
 *
 * Owner guiding principle (verbatim): „Bei Bedarf EINMAL: »Ja, dieser Agent darf auch
 * dort rein« (ein Tap auf einer Karte)." This is EXACTLY that one tap.
 *
 * When the R2 gate returns `requiresBridge:true` (execution-policy.ts), this
 * card shows the verbatim reason (NOT paraphrased — N1) prominently, plus
 * ONE primary action (Erlauben, brand gradient) and one secondary (Ablehnen).
 * Clear, calm, one tap — no security/sandbox vocabulary.
 *
 * Style: laz.ing Design Manifest v1.0 — Pitch-Black, SF Pro Display, brand gradient
 * (--a-now) ONLY on the primary action, 240ms cubic-bezier. No hex directly in
 * TSX. No emojis. Model: lib/chat/EnginePill.tsx.
 */

import { useRef, useState, type CSSProperties } from 'react';

interface Props {
  /** Verbatim reason from the R2 gate, do NOT paraphrase (N1). */
  reason: string;
  /** Workspace requesting the access (from_coord). */
  fromWorkspaceId: string;
  /** Target path to be accessed (to_coord project.path). */
  targetPath: string;
  access: 'ro' | 'rw';
  onApprove: () => void;
  onDeny: () => void;
}

export function BridgeApproveCard({
  reason,
  fromWorkspaceId,
  targetPath,
  access,
  onApprove,
  onDeny,
}: Props): React.JSX.Element {
  // Prevents a double tap; once decided, we lock both actions.
  // The ref guard takes effect IMMEDIATELY (synchronously), independent of the
  // re-render — the disabled state is only the visual confirmation afterwards.
  const [decided, setDecided] = useState(false);
  const decidedRef = useRef(false);

  const approve = (): void => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    setDecided(true);
    onApprove();
  };
  const deny = (): void => {
    if (decidedRef.current) return;
    decidedRef.current = true;
    setDecided(true);
    onDeny();
  };

  return (
    <div style={cardStyle} role="group" aria-label="Übergreifenden Zugriff erlauben" data-test="bridge-approve-card">
      <div style={kickerStyle} data-test="bridge-kicker">
        Übergreifender Zugriff
      </div>

      {/* Verbatim reason — prominent, unchanged (N1). */}
      <p style={reasonStyle} data-test="bridge-reason">
        {reason}
      </p>

      <dl style={metaStyle}>
        <div style={metaRowStyle}>
          <dt style={metaKeyStyle}>von</dt>
          <dd style={metaValStyle} data-test="bridge-from">
            {fromWorkspaceId}
          </dd>
        </div>
        <div style={metaRowStyle}>
          <dt style={metaKeyStyle}>auf</dt>
          <dd style={metaPathStyle} data-test="bridge-target" title={targetPath}>
            {targetPath}
          </dd>
        </div>
        <div style={metaRowStyle}>
          <dt style={metaKeyStyle}>Recht</dt>
          <dd style={metaValStyle} data-test="bridge-access">
            {access === 'rw' ? 'Lesen & Schreiben' : 'Nur Lesen'}
          </dd>
        </div>
      </dl>

      <div style={actionsStyle}>
        {/* ONE primary action — brand gradient. */}
        <button
          type="button"
          onClick={approve}
          disabled={decided}
          style={approveStyle(!decided)}
          data-test="bridge-approve"
        >
          Erlauben
        </button>
        <button
          type="button"
          onClick={deny}
          disabled={decided}
          style={denyStyle}
          data-test="bridge-deny"
        >
          Ablehnen
        </button>
      </div>
    </div>
  );
}

// ---- Styles (Pitch-Black + brand-gradient only on the primary action) ----

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: 18,
  maxWidth: 460,
  borderRadius: 16,
  background: 'var(--sheet-1, #0b0b0b)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  boxShadow: '0 16px 36px rgba(0,0,0,0.4)',
  fontFamily: "var(--font-sans, 'SF Pro Display', system-ui)",
  color: 'var(--ink, #f5f5f5)',
};

const kickerStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-3, #6b6b6b)',
};

const reasonStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  lineHeight: 1.45,
  fontWeight: 500,
  letterSpacing: '-0.01em',
  color: 'var(--ink, #f5f5f5)',
};

const metaStyle: CSSProperties = {
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  borderRadius: 12,
  background: 'var(--sheet-2, #0e0e0e)',
  border: '0.5px solid var(--line-2, #1f1f1f)',
};

const metaRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
};

const metaKeyStyle: CSSProperties = {
  margin: 0,
  width: 44,
  flexShrink: 0,
  fontSize: 11,
  letterSpacing: '0.02em',
  color: 'var(--ink-3, #6b6b6b)',
};

const metaValStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: 'var(--ink, #f5f5f5)',
};

const metaPathStyle: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono, ui-monospace)',
  fontSize: 12,
  color: 'var(--ink, #f5f5f5)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  letterSpacing: '-0.01em',
};

const actionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

function approveStyle(enabled: boolean): CSSProperties {
  return {
    appearance: 'none',
    cursor: enabled ? 'pointer' : 'default',
    flex: 1,
    fontSize: 14,
    fontWeight: 600,
    padding: '11px 16px',
    borderRadius: 12,
    color: enabled ? 'var(--sheet, #070707)' : 'var(--ink-3, #6b6b6b)',
    background: enabled ? 'var(--a-now, #c9ff4d)' : 'var(--sheet-2, #0e0e0e)',
    border: 'none',
    transition: 'background 240ms cubic-bezier(0.16, 1, 0.3, 1)',
  };
}

const denyStyle: CSSProperties = {
  appearance: 'none',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 500,
  padding: '11px 16px',
  borderRadius: 12,
  color: 'var(--ink-3, #6b6b6b)',
  background: 'transparent',
  border: '0.5px solid var(--line-2, #1f1f1f)',
  transition: 'color 240ms cubic-bezier(0.16, 1, 0.3, 1)',
};

export default BridgeApproveCard;
