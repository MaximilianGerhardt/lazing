'use client';

/**
 * MilestoneCard — Apple-Keynote-style completion card.
 *
 * Emitted when a workstream / bug-fix / feature is completed.
 * Massive whitespace, one accent color, large typography. Should feel
 * like an Apple Keynote slide.
 *
 * Wave 3.1 — Refactored: inline styles → CSS classes + token bind.
 * Mount animation via `srf-pop`, press scale on the link, spring easings.
 */

import type { ReactNode } from 'react';

import { IntentPill } from '@/lib/ui/pil';
import type { WorkstreamIntent } from '@/lib/workstreams/intent-classifier';

import { IconCheck } from '../nav/icons';

import { SourceChipRow } from './source-chip-row';

export interface MilestoneProps {
  headline?: string;
  /** "What was done" bullet points (≤7 recommended). */
  bullets?: string[];
  /** Cost-saved badge ("MAX-Plan, gespart €2.40 vs API"). */
  costSaved?: string;
  /** Quality score (0..5). */
  quality?: number;
  /** Optional workstream link. */
  href?: string;
  /** Secondary sub-headline (smaller, subtle). */
  sub?: string;
  /** Before/after snapshot, on a UI change. */
  beforeAfter?: { before?: string; after?: string };
  /**
   * Optional: reasoning-audit ID — triggers the source-chip footer (P11).
   * Set in the event-to-surface mapper for synthesis cards.
   */
  auditId?: string;
  /**
   * 2026-05-01 — Optional intent marker. When set, renders an
   * IntentPill in the header next to the done badge. Makes idea/bug-fix/
   * implementation visually distinguishable.
   */
  intent?: WorkstreamIntent;
  /**
   * 2026-05-30 (Apple-UX Slice 1) — `'quiet'` renders a calm info line
   * instead of the large keynote card. For info milestones (e.g. plan synthesis)
   * that must NEVER be louder than a blocking gate. Default = loud.
   */
  variant?: 'quiet';
}

export function MilestoneCard({
  headline = 'Erledigt.',
  bullets,
  costSaved,
  quality,
  href,
  sub,
  beforeAfter,
  auditId,
  intent,
  variant,
}: MilestoneProps) {
  // Apple-UX: calm info variant — info stays fully preserved
  // (headline/sub/bullets/href), but visually quiet (no keynote format).
  if (variant === 'quiet') {
    return (
      <article
        className="srf-milestone srf-milestone--quiet"
        data-test="milestone-quiet"
        aria-label={`Info: ${headline}`}
      >
        <div className="srf-milestone__quiet-row">
          <span className="srf-milestone__quiet-mark" aria-hidden="true" />
          <span className="srf-milestone__quiet-head">{headline}</span>
          {costSaved ? (
            <span className="srf-milestone__cost-badge">{costSaved}</span>
          ) : null}
        </div>
        {sub ? <p className="srf-milestone__quiet-sub">{sub}</p> : null}
        {bullets && bullets.length > 0 ? (
          <ul className="srf-milestone__quiet-list">
            {bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        ) : null}
        {auditId ? <SourceChipRow auditId={auditId} maxVisible={5} /> : null}
        {href ? (
          <a href={href} className="srf-milestone__quiet-link">
            {/* Apple-UX (2026-05-30): link text matches the target — a
                ticket href is not a „Plan". `/tickets/...` → „Ansehen →",
                otherwise (plan/workstream) → „Plan ansehen →". */}
            {href.includes('/tickets/') ? 'Ansehen →' : 'Plan ansehen →'}
          </a>
        ) : null}
      </article>
    );
  }

  return (
    <article className="srf-milestone" aria-label={`Milestone: ${headline}`}>
      <header className="srf-milestone__header">
        <span className="srf-milestone__badge"><IconCheck size={13} /> Done</span>
        {intent ? <IntentPill intent={intent} /> : null}
        {costSaved ? (
          <span className="srf-milestone__cost-badge">{costSaved}</span>
        ) : null}
        {typeof quality === 'number' ? (
          <span className="srf-milestone__quality">{renderStars(quality)}</span>
        ) : null}
      </header>

      <h2 className="srf-milestone__headline">{headline}</h2>
      {sub ? <p className="srf-milestone__sub">{sub}</p> : null}

      {bullets && bullets.length > 0 ? (
        <ul className="srf-milestone__list">
          {bullets.map((b, i) => (
            <li key={i} className="srf-milestone__item">
              <span className="srf-milestone__dot" aria-hidden="true" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {beforeAfter ? (
        <div className="srf-milestone__diff-grid">
          {beforeAfter.before ? (
            <div className="srf-milestone__diff-block">
              <span className="srf-milestone__diff-label">Vorher</span>
              <span className="srf-milestone__diff-text srf-milestone__diff-text--before">
                {beforeAfter.before}
              </span>
            </div>
          ) : null}
          {beforeAfter.after ? (
            <div className="srf-milestone__diff-block srf-milestone__diff-block--after">
              <span className="srf-milestone__diff-label srf-milestone__diff-label--after">
                Nachher
              </span>
              <span className="srf-milestone__diff-text">
                {beforeAfter.after}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {auditId ? <SourceChipRow auditId={auditId} maxVisible={5} /> : null}

      {href ? (
        <a href={href} className="srf-milestone__link">
          Details →
        </a>
      ) : null}
    </article>
  );
}

/** Filled star — inline SVG, inherits currentColor (adapts to the dim class). */
function Star(): ReactNode {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3l2.6 5.6 6.1.7-4.5 4.1 1.2 6L12 16.9 6.6 19.5l1.2-6-4.5-4.1 6.1-.7L12 3z" />
    </svg>
  );
}

function renderStars(score: number): ReactNode {
  const full = Math.round(Math.max(0, Math.min(5, score)));
  return (
    <span aria-label={`Qualität ${full} von 5`}>
      {Array.from({ length: full }).map((_, i) => (
        <Star key={i} />
      ))}
      <span className="srf-milestone__quality-dim">
        {Array.from({ length: 5 - full }).map((_, i) => (
          <Star key={i} />
        ))}
      </span>
    </span>
  );
}
