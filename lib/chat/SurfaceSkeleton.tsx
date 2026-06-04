'use client';

/**
 * SurfaceSkeleton — ruhige Form-Vorzeichnung der kommenden Surface-Card.
 *
 * Erkennung in `renderChatText`: wenn im Tail-Text ein `<surface:KIND>`
 * ohne entsprechenden `</surface:KIND>` auftaucht, rendert der Renderer
 * statt der unfertigen JSON-Garbage einen Skeleton-Block. Die Höhe/Form
 * orientiert sich am Surface-Kind, damit das Layout nicht springt wenn
 * die echte Card kurz danach reinkommt.
 *
 * Apple-HIG (2026-05-30): KEIN „… streamt"-Text mehr im Produkt. Statt
 * eines technischen Status-Worts zeichnen wir die STRUKTUR der kommenden
 * Card vor — ein paar Phase-Outline-Pills + eine dünne Brand-Hairline
 * (var(--a-now)) als Progress-Geste. Ruhig, eine Akzent-Linie, der Shimmer
 * trägt die „in Arbeit"-Bedeutung (motion-meaning) statt eines Labels.
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
      {/* Brand-Progress-Hairline (oben) — die einzige Akzent-Geste. */}
      <div style={hairlineStyle} aria-hidden="true" />

      {/* Form-Vorzeichnung: strukturelle Outline der kommenden Card.
          Phase-Outline-Pills (Header-Row) + ruhige Inhalts-Zeilen. */}
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
  // Opaque (war 70%/transparent) — Parent-Bleed-Fix (Sweep 2026-05-01)
  background: 'var(--sheet-2)',
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
};

// Dünne Brand-Hairline oben — Progress-Geste statt Status-Wort.
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

// Strukturelle Form-Vorzeichnung der kommenden Card.
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
