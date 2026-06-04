'use client';

/**
 * SourceChip — kompakte klickbare Quellen-Pille.
 *
 * P11 (2026-05-01): Anne-Quote "aus jedem Punkt im Prinzip in unserer App
 * kann man sich immer den Originalgesetzestext... ausgeben lassen". Jede
 * Synthesis-Card / Sniper-V_n-Card im Chat-Stream bekommt klickbare Source-
 * Chips, die auf den exakten Quell-Chunk (RAG / Prior-Output / Memory)
 * verweisen.
 *
 * Visual: Apple-pure pill, one accent glyph depending on kind, hover shows
 * the full ref. Click opens an inline drawer (NO modal overlays — see
 * MEMORY sticky "KEINE Overlays — Surface-Library nutzen") directly below
 * the chip row with a quote snippet (max 300 chars from the source).
 */

import { type CSSProperties } from 'react';

export type SourceKind = 'rag' | 'prior-output' | 'memory';

export interface SourceChipProps {
  kind: SourceKind;
  /** 'file:abc' / 'ticket:tck_x' / 'phase:v2:hash123' */
  ref: string;
  /** RAG-Cosine 0..1 — optional. */
  similarity?: number;
  onClick?: () => void;
  /** Visuell aktiv (Drawer offen)? */
  active?: boolean;
}

const ICON: Record<SourceKind, string> = {
  rag: '◆',
  'prior-output': '↳',
  memory: '◉',
};

const LABEL: Record<SourceKind, string> = {
  rag: 'RAG',
  'prior-output': 'Prior',
  memory: 'Memory',
};

export function shortenRef(ref: string): string {
  // 'file:/very/long/path/to/file.ts' → 'file:file.ts'
  // 'ticket:tck_abc123' → 'ticket:tck_abc123'
  // 'phase:v2:hash123' → 'phase:v2:hash123'
  if (ref.startsWith('file:')) {
    const path = ref.slice('file:'.length);
    const base = path.split('/').filter(Boolean).pop() ?? path;
    return `file:${base}`;
  }
  if (ref.length > 32) return `${ref.slice(0, 30)}…`;
  return ref;
}

export function SourceChip({
  kind,
  ref,
  similarity,
  onClick,
  active = false,
}: SourceChipProps): React.JSX.Element {
  const interactive = typeof onClick === 'function';
  const simPct =
    typeof similarity === 'number' && Number.isFinite(similarity)
      ? Math.round(Math.max(0, Math.min(1, similarity)) * 100)
      : null;

  const content = (
    <>
      <span style={iconStyle} aria-hidden="true">
        {ICON[kind]}
      </span>
      <span style={labelStyle}>{LABEL[kind]}</span>
      <span style={refStyle}>{shortenRef(ref)}</span>
      {simPct !== null ? <span style={simStyle}>{simPct}%</span> : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={`${LABEL[kind]} · ${ref}${simPct !== null ? ` · ${simPct}%` : ''}`}
        style={chipStyle(kind, active, true)}
        data-testid={`source-chip-${kind}`}
        aria-pressed={active}
      >
        {content}
      </button>
    );
  }

  return (
    <span
      title={`${LABEL[kind]} · ${ref}${simPct !== null ? ` · ${simPct}%` : ''}`}
      style={chipStyle(kind, active, false)}
      data-testid={`source-chip-${kind}`}
    >
      {content}
    </span>
  );
}

// ────────────────────────────── Styles ──────────────────────────────

function chipStyle(
  kind: SourceKind,
  active: boolean,
  interactive: boolean,
): CSSProperties {
  const accent: Record<SourceKind, string> = {
    rag: 'var(--a-now, #3b82f6)',
    'prior-output': 'var(--ink-2)',
    memory: 'var(--a-clientb, #1f9d55)',
  };
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 10px',
    borderRadius: 999,
    border: `0.5px solid ${active ? accent[kind] : 'var(--line-2)'}`,
    background: active
      ? `color-mix(in oklab, ${accent[kind]} 12%, var(--sheet))`
      : 'var(--sheet)',
    color: active ? accent[kind] : 'var(--ink-2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    letterSpacing: '0.01em',
    cursor: interactive ? 'pointer' : 'default',
    appearance: 'none',
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    maxWidth: 280,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}

const iconStyle: CSSProperties = {
  fontSize: 11,
  lineHeight: 1,
  opacity: 0.9,
};

const labelStyle: CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontSize: 9,
  opacity: 0.7,
};

const refStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 180,
};

const simStyle: CSSProperties = {
  marginLeft: 4,
  padding: '0 6px',
  borderRadius: 999,
  background: 'color-mix(in oklab, currentColor 14%, transparent)',
  fontSize: 10,
};
