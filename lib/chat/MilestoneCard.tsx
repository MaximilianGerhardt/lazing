'use client';

/**
 * MilestoneCard — Apple-Keynote-Style Completion-Card.
 *
 * Wird emitiert wenn ein Workstream / Bug-Fix / Feature abgeschlossen
 * ist. Massiver Whitespace, eine Akzent-Farbe, große Typo. Soll sich
 * wie ein Apple-Keynote-Slide anfuehlen.
 *
 * Welle 3.1 — Refactored: Inline-Styles → CSS-Klassen + Token-Bind.
 * Mount-Animation via `srf-pop`, Press-Scale auf Link, Spring-Easings.
 */

import type { ReactNode } from 'react';

import { IntentPill } from '@/lib/ui/pil';
import type { WorkstreamIntent } from '@/lib/workstreams/intent-classifier';

import { IconCheck } from '../nav/icons';

import { SourceChipRow } from './source-chip-row';

export interface MilestoneProps {
  headline?: string;
  /** "Was wurde gemacht" Bullet-Points (≤7 empfohlen). */
  bullets?: string[];
  /** Cost-Saved-Badge ("MAX-Plan, gespart €2.40 vs API"). */
  costSaved?: string;
  /** Quality-Score (0..5). */
  quality?: number;
  /** Optional Workstream-Link. */
  href?: string;
  /** Sekundäre Sub-Headline (kleiner, dezent). */
  sub?: string;
  /** Vorher/Nachher-Snapshot, wenn UI-Change. */
  beforeAfter?: { before?: string; after?: string };
  /**
   * Optional: Reasoning-Audit-ID — triggert Source-Chip-Footer (P11).
   * Wird im event-to-surface-Mapper für Synthesis-Cards gesetzt.
   */
  auditId?: string;
  /**
   * 2026-05-01 — Optionaler Intent-Marker. Wenn gesetzt, rendert eine
   * IntentPill im Header neben dem Done-Badge. Macht Idee/Bug-Fix/
   * Implementation visuell unterscheidbar.
   */
  intent?: WorkstreamIntent;
  /**
   * 2026-05-30 (Apple-UX Slice 1) — `'quiet'` rendert eine ruhige Info-Zeile
   * statt der großen Keynote-Card. Für Info-Milestones (z.B. Plan-Synthese),
   * die NIE lauter sein dürfen als ein blockierendes Gate. Default = laut.
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
  // Apple-UX: ruhige Info-Variante — Info bleibt vollständig erhalten
  // (headline/sub/bullets/href), aber visuell leise (kein Keynote-Format).
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
            {/* Apple-UX (2026-05-30): Link-Text passt zum Ziel — ein
                Ticket-href ist kein „Plan". `/tickets/...` → „Ansehen →",
                sonst (Plan/Workstream) → „Plan ansehen →". */}
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

/** Gefuellter Stern — Inline-SVG, erbt currentColor (passt sich Dim-Klasse an). */
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
