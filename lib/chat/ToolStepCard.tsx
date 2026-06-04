'use client';

import { useState, type JSX } from 'react';

import {
  IconCheck,
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
import type { ToolStep } from './types';

interface ToolStepCardProps {
  step: ToolStep;
  /** Optional index within the turn — used for a subtle leading count. */
  index?: number;
}

/**
 * One tool invocation rendered as a compact pill-card with an expandable
 * output-drawer. Matches the LazyOS Manifest pitch-black + accent-glow
 * language: `var(--card)` base, 0.5px `var(--line-2)` border, optional
 * `var(--a-now)` glow while running.
 *
 * Welle 4 (2026-05-01): Inline-Styles auf `.srf-tool*` CSS-Klassen
 * verlagert (siehe `app/components.css` Block B''). Token-bind, kein
 * Inline-Layout.
 */
export function ToolStepCard({ step, index }: ToolStepCardProps): JSX.Element {
  const [open, setOpen] = useState(false);

  const { statusColor, statusLabel } = statusPresentation(step);

  const durationMs =
    step.endedAt !== undefined ? step.endedAt - step.startedAt : undefined;

  const hasOutput = Boolean(step.outputPreview);
  const canExpand = hasOutput || step.status === 'denied';

  const iconModifier =
    step.status === 'running'
      ? ' srf-tool__icon--running'
      : step.status === 'denied'
        ? ' srf-tool__icon--denied'
        : '';

  return (
    <div
      className="srf-tool"
      role="group"
      aria-label={`Tool ${step.name} · ${statusLabel}`}
      data-tool-status={step.status}
    >
      <style>{`
        @keyframes lazyos-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
      <div className="srf-tool__header">
        <div className="srf-tool__lead">
          <span className={`srf-tool__icon${iconModifier}`} aria-hidden="true">
            <ToolIcon name={step.name} size={14} />
          </span>
          {typeof index === 'number' ? (
            <span className="srf-tool__index">{String(index + 1).padStart(2, '0')}</span>
          ) : null}
          <span className="srf-tool__name">{step.name}</span>
          <span className="srf-tool__preview" title={step.inputPreview}>
            {step.inputPreview}
          </span>
        </div>
        <div className="srf-tool__status-wrap">
          <span
            className="srf-tool__pill"
            style={{ color: statusColor, borderColor: statusColor }}
            aria-hidden={step.status === 'running'}
          >
            <StatusGlyph status={step.status} isError={step.isError ?? false} size={11} />
            <span>{statusLabel}</span>
          </span>
          {durationMs !== undefined ? (
            <span
              className="srf-tool__duration"
              aria-label={`Dauer ${durationMs} Millisekunden`}
            >
              {formatDuration(durationMs)}
            </span>
          ) : null}
          {canExpand ? (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={`tool-out-${step.id}`}
              className="srf-tool__toggle press"
            >
              {open ? 'zuklappen' : 'Details'}
            </button>
          ) : null}
        </div>
      </div>

      {open && canExpand ? (
        <div id={`tool-out-${step.id}`} className="srf-tool__output-wrap">
          {step.status === 'denied' && step.denialReason ? (
            <div className="srf-tool__denial">
              Abgelehnt — {step.denialReason}
            </div>
          ) : null}
          {step.outputPreview ? (
            <pre className="srf-tool__output">{step.outputPreview}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers — declared at module scope so react-hooks/static-components is happy.
// ---------------------------------------------------------------------------

function ToolIcon({ name, size = 14 }: { name: string; size?: number }): JSX.Element {
  // Pick-by-name instead of building a component expression inside render.
  const n = name.toLowerCase();
  if (n === 'read') return <IconFile size={size} />;
  if (n === 'write' || n === 'edit' || n === 'multiedit') return <IconFilePen size={size} />;
  if (n === 'bash' || n === 'shell' || n === 'terminal') return <IconTerminal size={size} />;
  if (n === 'grep' || n === 'glob' || n === 'search') return <IconSearch size={size} />;
  if (n === 'webfetch' || n === 'websearch' || n === 'fetch') return <IconGlobe size={size} />;
  return <IconWrench size={size} />;
}

function StatusGlyph({
  status,
  isError,
  size = 11,
}: {
  status: ToolStep['status'];
  isError: boolean;
  size?: number;
}): JSX.Element {
  if (status === 'running') {
    return (
      <span
        style={{
          display: 'inline-flex',
          animation: 'lazyos-spin 1s linear infinite',
        }}
      >
        <IconSpinner size={size} />
      </span>
    );
  }
  if (status === 'denied') return <IconShield size={size} />;
  if (status === 'error' || (status === 'done' && isError)) return <IconX size={size} />;
  if (status === 'done') return <IconCheck size={size} />;
  return <IconX size={size} />;
}

function statusPresentation(step: ToolStep): {
  statusColor: string;
  statusLabel: string;
} {
  if (step.status === 'running') {
    return { statusColor: 'var(--a-now)', statusLabel: 'läuft' };
  }
  if (step.status === 'done' && step.isError) {
    return { statusColor: 'var(--a-danger)', statusLabel: 'Fehler' };
  }
  if (step.status === 'done') {
    return { statusColor: 'var(--a-clientb)', statusLabel: 'fertig' };
  }
  if (step.status === 'error') {
    return { statusColor: 'var(--a-danger)', statusLabel: 'Fehler' };
  }
  if (step.status === 'denied') {
    return { statusColor: 'var(--a-warn)', statusLabel: 'blockiert' };
  }
  return { statusColor: 'var(--ink-3)', statusLabel: step.status };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}
