'use client';

/**
 * TpmIndicator — Phase QA pill in the TopNav (2026-04-28)
 *
 * Shows the current TPM consumption of the MAX-plan bucket. Polls every 8s,
 * color by utilization:
 *   green  (<50%)  — all relaxed
 *   yellow (50-70) — slight drip
 *   orange (70-90) — adaptive throttling kicks in
 *   red    (>90)   — new spawns block briefly
 *   over   (>100)  — hard block 30s
 *
 * A click opens no detail page (no override wanted currently);
 * the tooltip shows raw numbers.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface TopConsumer {
  id: string;
  role: string | null;
  name: string;
  tokens: number;
  costCents: number;
  workspaceId: string;
}

interface TpmStatus {
  current: number;
  max: number;
  pct: number;
  level: 'green' | 'yellow' | 'orange' | 'red' | 'over';
  recentSpawns: number;
  recommendedDelayMs: number;
  /** Phase MU.4 — 'own' = consumption of the logged-in user (their own MAX plan). */
  scope?: 'shared' | 'own';
  /** Sprint C (2026-04-29) — top-3 sub-workspaces of the last 60s. */
  topConsumers?: TopConsumer[];
}

const POLL_INTERVAL_MS = 8000;

export function TpmIndicator() {
  const [status, setStatus] = useState<TpmStatus | null>(null);
  // P1-3: open state instead of pure hover. Click toggles on touch, hover
  // opens on desktop, click-outside closes.
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/quota/tpm-status', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!res.ok) return;
        const json = (await res.json()) as TpmStatus;
        if (!cancelled) setStatus(json);
      } catch {
        /* offline — pill disappears */
      }
    };
    void tick();
    const interval = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // P1-3: click-outside closes the popover. Only register when open.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent): void => {
      const target = e.target as Node | null;
      if (popoverRef.current && target && !popoverRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('touchstart', onPointer);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('touchstart', onPointer);
    };
  }, [open]);

  if (!status) return null;
  // Only show the pill when something is actually happening (>10% utilization).
  // Otherwise clutter-free.
  if (status.pct < 10) return null;

  const color = colorForLevel(status.level);
  const scopeBadge = status.scope === 'own' ? '·me' : '';
  const label = `TPM ${status.pct}%${scopeBadge}`;
  const scopeLine =
    status.scope === 'own'
      ? 'Scope: dein eigener MAX-Plan (own)\n'
      : 'Scope: shared System-Token\n';
  const tooltip = `${scopeLine}MAX-Plan-Bucket: ${status.current.toLocaleString('de-DE')} / ${status.max.toLocaleString('de-DE')} Tokens (rolling 60s)\n${status.recentSpawns} aktive Spawns\n${
    status.recommendedDelayMs > 0
      ? `Adaptive Drosselung: +${Math.round(status.recommendedDelayMs / 1000)}s pre-spawn delay`
      : 'Keine Drosselung'
  }`;

  const topConsumers = (status.topConsumers ?? []).slice(0, 3);
  const showPopover = open && topConsumers.length > 0;

  return (
    <span
      ref={popoverRef}
      className="topnav-tpm"
      title={tooltip}
      aria-label={tooltip}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setOpen((o) => !o);
        }
        if (e.key === 'Escape') setOpen(false);
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        // Only close when focus actually leaves the pill
        // (not when switching to popover content). The click-outside listener
        // handles the tap path.
        const next = e.relatedTarget as Node | null;
        if (!next || !popoverRef.current?.contains(next)) {
          setOpen(false);
        }
      }}
      style={{
        ...pillStyle,
        color,
        borderColor: color,
        background: `color-mix(in oklab, ${color} 14%, transparent)`,
        position: 'relative',
      }}
    >
      <span aria-hidden style={{ ...dotStyle, background: color }} />
      {label}
      {showPopover ? (
        <span style={popoverStyle} role="status" aria-live="polite">
          <span style={popoverHeaderStyle}>Top Sub-Agents (60s)</span>
          {topConsumers.map((c) => (
            <span key={c.id} style={popoverRowStyle}>
              <span style={popoverRoleStyle}>{c.role ?? 'sub'}</span>
              <span style={popoverTokensStyle}>
                {c.tokens.toLocaleString('de-DE')} tok
              </span>
              <span style={popoverCostStyle}>
                €{(c.costCents / 100).toFixed(3)}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function colorForLevel(level: TpmStatus['level']): string {
  switch (level) {
    case 'green':
      return 'var(--a-now)';
    case 'yellow':
      return 'var(--a-warn)';
    case 'orange':
      return '#ff9d3a';
    case 'red':
      return 'var(--a-danger)';
    case 'over':
      return 'var(--a-danger)';
  }
}

const pillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  borderRadius: 999,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  letterSpacing: 0.4,
  border: '0.5px solid',
  cursor: 'help',
  whiteSpace: 'nowrap',
};

const dotStyle: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  flexShrink: 0,
};

// Sprint C (2026-04-29) — hover popover with the top-3 sub-workspaces.
const popoverStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  minWidth: 220,
  padding: '8px 10px',
  borderRadius: 8,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-3)',
  color: 'var(--ink)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  letterSpacing: 0.2,
  zIndex: 1000,
  cursor: 'default',
};

const popoverHeaderStyle: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--ink-2)',
  marginBottom: 2,
};

const popoverRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr auto auto',
  gap: 8,
  alignItems: 'center',
};

const popoverRoleStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const popoverTokensStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-2)',
  fontVariantNumeric: 'tabular-nums',
};

const popoverCostStyle: CSSProperties = {
  fontSize: 11,
  color: 'var(--ink-2)',
  fontVariantNumeric: 'tabular-nums',
};
