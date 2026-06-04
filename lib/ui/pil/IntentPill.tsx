'use client';

/**
 * lib/ui/pil/IntentPill.tsx
 * --------------------------
 * 2026-05-01 — workstream intent marker.
 *
 * A narrow pill with an icon + label that VISUALLY signals whether a
 * workstream is an idea, an implementation, a bug fix, a question or
 * a discussion. Addresses the user finding "der unterschied zwischen der
 * implementierung der ideen noch immer nicht klar".
 *
 * Reuse: stylistically the pill builds on the existing `pill` family
 * (see app/components.css Section G · PIL), but uses its own
 * modifier class `intent-pill--<suffix>` for the accent color.
 *
 * Static (no onClick) → <span>. With onClick → <button> (e.g. for
 * reclassifying in the detail view — Phase 2).
 */

import type { ReactNode } from 'react';

import {
  getIntentMeta,
  type WorkstreamIntent,
} from '@/lib/workstreams/intent-classifier';

export interface IntentPillProps {
  intent: WorkstreamIntent;
  /** "Idee" / "Implementierung" — default true. False = icon only. */
  showLabel?: boolean;
  /** Custom sub-label override (for special cases like "Idee · Brainstorm"). */
  labelOverride?: string;
  /** Click → opens the reclassification sheet (Phase 2). */
  onClick?: () => void;
  className?: string;
}

export function IntentPill({
  intent,
  showLabel = true,
  labelOverride,
  onClick,
  className,
}: IntentPillProps): ReactNode {
  const meta = getIntentMeta(intent);
  const label = labelOverride ?? meta.label;
  const cls = [
    'pill',
    'intent-pill',
    `intent-pill--${meta.cssSuffix}`,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const ariaLabel = `Intent: ${label}`;

  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        <span aria-hidden="true" className="intent-pill__icon">
          {meta.icon}
        </span>
        {showLabel ? <span>{label}</span> : null}
      </button>
    );
  }

  return (
    <span className={cls} aria-label={ariaLabel}>
      <span aria-hidden="true" className="intent-pill__icon">
        {meta.icon}
      </span>
      {showLabel ? <span>{label}</span> : null}
    </span>
  );
}

export default IntentPill;
