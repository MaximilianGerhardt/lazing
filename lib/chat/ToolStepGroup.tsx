'use client';

/**
 * ToolStepGroup — groups consecutive tool calls of the same kind (e.g. 5x
 * Bash in a row) into a single expandable card.
 *
 * Default collapsed when group.length >= 2. The header shows the tool name +
 * count + aggregated status pill + total duration. Clicking expands the
 * individual steps as ToolStepCards.
 *
 * At group.length === 1, the single ToolStepCard is passed through directly
 * (no group-wrap overhead).
 */

import { memo, useState, type CSSProperties, type JSX } from 'react';

import {
  IconCheck,
  IconChevronDown,
  IconFile,
  IconFilePen,
  IconGlobe,
  IconSearch,
  IconShield,
  IconSpinner,
  IconTerminal,
  IconWrench,
  IconX,
} from './icons';
import { ToolStepCard } from './ToolStepCard';
import type { ToolStep } from './types';

interface Props {
  toolName: string;
  steps: ToolStep[];
  startIndex: number;
}

function ToolStepGroupImpl({ toolName, steps, startIndex }: Props): JSX.Element {
  // Hook must be at top level — before any early return (Rules of Hooks).
  const [open, setOpen] = useState(false);

  // Single step → no grouping, render directly.
  if (steps.length === 1) {
    return <ToolStepCard step={steps[0]} index={startIndex} />;
  }

  const totalDuration = steps.reduce((sum, s) => {
    if (s.endedAt !== undefined) return sum + (s.endedAt - s.startedAt);
    return sum;
  }, 0);
  const running = steps.filter((s) => s.status === 'running').length;
  const failed = steps.filter(
    (s) => s.status === 'error' || (s.status === 'done' && s.isError) || s.status === 'denied',
  ).length;
  const done = steps.filter((s) => s.status === 'done' && !s.isError).length;

  const groupStatus: 'running' | 'done' | 'error' | 'mixed' =
    running > 0
      ? 'running'
      : failed === steps.length
        ? 'error'
        : failed > 0
          ? 'mixed'
          : 'done';

  return (
    <div
      style={groupStyle(groupStatus)}
      role="group"
      aria-label={`${steps.length} ${toolName}-Aufrufe`}
    >
      <style>{`
        @keyframes lazyos-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={headerBtnStyle}
        aria-expanded={open}
      >
        <span style={iconWrapStyle(groupStatus)} aria-hidden="true">
          <ToolIcon name={toolName} size={14} />
        </span>
        <span style={countBadgeStyle}>×{steps.length}</span>
        <span style={nameStyle}>{toolName}</span>

        <span style={summaryStyle}>
          {running > 0 ? (
            <>
              <span style={liveDotStyle} /> {running} läuft
            </>
          ) : failed > 0 ? (
            <>
              <span style={errorDotStyle} /> {failed}/{steps.length} Fehler
            </>
          ) : (
            <>{done} fertig</>
          )}
        </span>

        {totalDuration > 0 ? (
          <span style={durationStyle}>{formatDuration(totalDuration)}</span>
        ) : null}

        <span
          style={{
            ...chevronStyle,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
          aria-hidden="true"
        >
          <IconChevronDown size={14} />
        </span>
      </button>

      {open ? (
        <div style={childrenStyle}>
          {steps.map((s, i) => (
            <ToolStepCard key={s.id} step={s} index={startIndex + i} />
          ))}
        </div>
      ) : (
        // Compact preview: one-liner of the first 2 steps + "..." indicator
        <div style={previewWrapStyle}>
          {steps.slice(0, 2).map((s) => (
            <div key={s.id} style={previewLineStyle} title={s.inputPreview}>
              <span style={previewBulletStyle}>·</span>
              <span style={previewTextStyle}>{s.inputPreview}</span>
            </div>
          ))}
          {steps.length > 2 ? (
            <div style={previewMoreStyle}>+ {steps.length - 2} weitere</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ToolIcon({ name, size = 14 }: { name: string; size?: number }): JSX.Element {
  const n = name.toLowerCase();
  if (n === 'read') return <IconFile size={size} />;
  if (n === 'write' || n === 'edit' || n === 'multiedit') return <IconFilePen size={size} />;
  if (n === 'bash' || n === 'shell' || n === 'terminal') return <IconTerminal size={size} />;
  if (n === 'grep' || n === 'glob' || n === 'search') return <IconSearch size={size} />;
  if (n === 'webfetch' || n === 'websearch' || n === 'fetch') return <IconGlobe size={size} />;
  return <IconWrench size={size} />;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function groupStyle(
  status: 'running' | 'done' | 'error' | 'mixed',
): CSSProperties {
  const accent =
    status === 'running'
      ? 'var(--a-now)'
      : status === 'error'
        ? 'var(--a-danger)'
        : status === 'mixed'
          ? 'var(--a-warn)'
          : 'var(--line-2)';
  return {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: 12,
    border: `0.5px solid ${accent}`,
    // Opaque (was 80%/transparent) — parent-bleed fix (Sweep 2026-05-01)
    background: 'var(--sheet-2)',
    overflow: 'hidden',
    marginTop: 4,
  };
}

const headerBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  width: '100%',
  textAlign: 'left',
  color: 'var(--ink)',
};

function iconWrapStyle(status: 'running' | 'done' | 'error' | 'mixed'): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 6,
    background:
      status === 'running'
        ? 'color-mix(in oklab, var(--a-now) 18%, transparent)'
        : status === 'error'
          ? 'color-mix(in oklab, var(--a-danger) 18%, transparent)'
          : 'var(--card-2)',
    color:
      status === 'running'
        ? 'var(--a-now)'
        : status === 'error'
          ? 'var(--a-danger)'
          : 'var(--ink-2)',
  };
}

const countBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--a-now)',
  letterSpacing: '0.02em',
};

const nameStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  letterSpacing: '0.02em',
  color: 'var(--ink)',
};

const summaryStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const durationStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.02em',
};

const chevronStyle: CSSProperties = {
  display: 'inline-flex',
  color: 'var(--ink-3)',
  transition: 'transform 180ms ease',
};

const liveDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--a-now)',
  boxShadow: '0 0 8px var(--a-now)',
  animation: 'lazyos-spin 1s linear infinite',
};

const errorDotStyle: CSSProperties = {
  display: 'inline-block',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--a-danger)',
};

const childrenStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderTop: '0.5px solid var(--line)',
  padding: '6px 8px 8px',
  background: 'color-mix(in oklab, var(--sheet) 30%, transparent)',
};

const previewWrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '0 14px 10px 48px',
};

const previewLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--ink-3)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const previewBulletStyle: CSSProperties = {
  color: 'var(--ink-4)',
};

const previewTextStyle: CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  flex: 1,
};

const previewMoreStyle: CSSProperties = {
  fontSize: 10,
  fontFamily: 'var(--font-mono)',
  color: 'var(--ink-4)',
  letterSpacing: '0.04em',
  marginTop: 2,
};

// Sub-Plan E (2026-04-30) — React.memo. steps is an array of objects with
// status/timing fields that change constantly; JSON.stringify as a pragmatic
// choice (re-render is more expensive than the stringify comparison anyway).
function toolStepGroupPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.toolName === next.toolName &&
    prev.startIndex === next.startIndex &&
    JSON.stringify(prev.steps) === JSON.stringify(next.steps)
  );
}

export const ToolStepGroup = memo(ToolStepGroupImpl, toolStepGroupPropsEqual);
