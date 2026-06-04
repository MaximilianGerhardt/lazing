'use client';

/**
 * lib/ui/pil/IntentPill.tsx
 * --------------------------
 * 2026-05-01 — Workstream-Intent-Marker.
 *
 * Eine schmale Pille mit Icon + Label, die VISUELL signalisiert, ob ein
 * Workstream eine Idee, eine Implementation, ein Bug-Fix, eine Frage oder
 * eine Diskussion ist. Adressiert User-Befund "der unterschied zwischen der
 * implementierung der ideen noch immer nicht klar".
 *
 * Reuse: stilistisch baut die Pille auf der existierenden `pill`-Familie auf
 * (siehe app/components.css Section G · PIL), nutzt aber eine eigene
 * Modifier-Klasse `intent-pill--<suffix>` für die Akzent-Farbe.
 *
 * Statisch (kein onClick) → <span>. Mit onClick → <button> (z.B. zum
 * Re-Klassifizieren in der Detail-View — Phase 2).
 */

import type { ReactNode } from 'react';

import {
  getIntentMeta,
  type WorkstreamIntent,
} from '@/lib/workstreams/intent-classifier';

export interface IntentPillProps {
  intent: WorkstreamIntent;
  /** "Idee" / "Implementierung" — default true. False = nur Icon. */
  showLabel?: boolean;
  /** Eigener Sub-Label-Override (für Spezialfälle wie "Idee · Brainstorm"). */
  labelOverride?: string;
  /** Click → öffnet Re-Klassifikations-Sheet (Phase 2). */
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
