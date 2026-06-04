'use client';

/**
 * SurfaceSkeleton — calm form pre-sketch of the upcoming surface card.
 *
 * Detection in `renderChatText`: when a `<surface:KIND>` appears in the tail
 * text without a corresponding `</surface:KIND>`, the renderer renders
 * a skeleton block instead of the unfinished JSON garbage. The height/form
 * follows the surface kind, so the layout does not jump when
 * the real card comes in shortly after.
 *
 * Apple-HIG (2026-05-30): NO more „… streamt" text in the product. Instead
 * of a technical status word, we pre-sketch the STRUCTURE of the upcoming
 * card — a few phase-outline pills + a thin brand hairline
 * (var(--a-now)) as a progress gesture. Calm, one accent line, the shimmer
 * carries the „in progress" meaning (motion-meaning) instead of a label.
 */

import type { CSSProperties } from 'react';

import type { SurfaceKind } from './surface-parser';

interface Props {
  kind: SurfaceKind;
}

const KIND_HEIGHT: Partial<Record<SurfaceKind, number>> = {
  chart: 200,
  decision: 180,
  ticket: 110,
  invoice: 220,
  pipeline: 180,
  toast: 80,
  quickchoice: 90,
  approval: 130,
  terminal: 220,
  heartbeat: 90,
  workspace: 60,
  routine: 100,
  agent: 110,
  swarm: 200,
};

const KIND_LABEL: Partial<Record<SurfaceKind, string>> = {
  chart: 'Chart',
  decision: 'Entscheidung',
  ticket: 'Ticket',
  invoice: 'Rechnung',
  pipeline: 'Pipeline',
  toast: 'Toast',
  quickchoice: 'Auswahl',
  approval: 'Freigabe',
  terminal: 'Terminal',
  heartbeat: 'Heartbeat',
  workspace: 'Workspace',
  routine: 'Routine',
  agent: 'Agent',
  swarm: 'Swarm',
};

export function SurfaceSkeleton({ kind }: Props) {
  const height = KIND_HEIGHT[kind] ?? 140;
  const label = KIND_LABEL[kind] ?? 'Surface';
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={`${label} wird vorbereitet`}
      data-test="surface-skeleton"
      data-kind={kind}
      style={{
        ...wrapStyle,
        height,
      }}
    >
      {/* Brand progress hairline (top) — the only accent gesture. */}
      <div style={hairlineStyle} aria-hidden="true" />

      {/* Form pre-sketch: structural outline of the upcoming card.
          Phase-outline pills (header row) + calm content lines. */}
      <div style={outlineStyle} aria-hidden="true">
        <div style={pillRowStyle}>
          <span style={{ ...pillStyle, width: 56 }} />
          <span style={{ ...pillStyle, width: 38 }} />
          <span style={{ ...pillStyle, width: 30 }} />
        </div>
        <div style={{ ...rowStyle, width: '72%' }} />
        <div style={{ ...rowStyle, width: '54%' }} />
      </div>

      <div style={shimmerStyle} aria-hidden="true" />
    </div>
  );
}

const wrapStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: 520,
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  // Opaque (was 70%/transparent) — parent-bleed fix (Sweep 2026-05-01)
  background: 'var(--sheet-2)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

// Thin brand hairline at the top — progress gesture instead of a status word.
const hairlineStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  height: 2,
  width: '40%',
  background:
    'linear-gradient(90deg, transparent, var(--a-now, #6E8BFF), transparent)',
  borderRadius: 999,
  animation: 'lazyos-shimmer 1.8s ease-in-out infinite',
  backgroundSize: '300% 100%',
  zIndex: 2,
};

// Structural form pre-sketch of the upcoming card.
const outlineStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '18px 18px 0',
  zIndex: 2,
};

const pillRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
};

const pillStyle: CSSProperties = {
  display: 'inline-block',
  height: 16,
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--ink-3, #8A8A8A) 8%, transparent)',
};

const rowStyle: CSSProperties = {
  height: 9,
  borderRadius: 6,
  background: 'color-mix(in oklab, var(--ink-3, #8A8A8A) 10%, transparent)',
};

const shimmerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background:
    'linear-gradient(110deg, transparent 0%, transparent 35%, color-mix(in oklab, var(--a-now, #6E8BFF) 14%, transparent) 50%, transparent 65%, transparent 100%)',
  backgroundSize: '300% 100%',
  animation: 'lazyos-shimmer 1.6s linear infinite',
  zIndex: 1,
};
