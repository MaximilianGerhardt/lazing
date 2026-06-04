'use client';

/**
 * IterateRoastCard — Wave 7 (2026-05-01)
 *
 * Shows a single roaster output during the iterate-roast phase.
 * Via `roasterIdx`, 4-5 of these cards can be rendered in parallel in the stream
 * (one per roaster role: performance, hacker, pragmatist, user advocate,
 * devil's advocate).
 *
 * User finding 2026-05-01: 20 iterate-roast events in the DB, but no
 * dedicated surface — only toast or null. This card makes the roaster
 * voice visible as a persistent surface.
 *
 * Token bind: all values from app/components.css `.srf-iterate-roast__*`.
 */

import type { ReactElement } from 'react';

interface Props {
  workstreamId?: string;
  workspaceId?: string;
  /** 1-based: Roaster #1, #2, … */
  roasterIdx?: number;
  /** Free-text role ('iterate-roaster-1', 'performance-roaster', …). */
  role?: string;
  versionN?: number;
  text?: string;
  summary?: string;
}

function roleLabel(role: string | undefined, idx: number | undefined): string {
  if (role) {
    const cleaned = role.replace(/^iterate-roaster-/, 'Roaster ');
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  if (typeof idx === 'number') return `Roaster ${idx}`;
  return 'Roaster';
}

function avatarGlyph(role: string | undefined, idx: number | undefined): string {
  if (role) {
    const m = role.match(/(\d+)$/);
    if (m) return m[1];
    return role.slice(0, 1).toUpperCase();
  }
  if (typeof idx === 'number') return String(idx);
  return 'R';
}

export function IterateRoastCard(props: Props): ReactElement {
  const label = roleLabel(props.role, props.roasterIdx);
  const glyph = avatarGlyph(props.role, props.roasterIdx);
  const headline = `${label}${typeof props.versionN === 'number' ? ` · V${props.versionN}` : ''}`;
  const body = props.text ?? props.summary ?? '';
  return (
    <div className="srf-iterate-roast" role="region" aria-label={`Roaster: ${label}`}>
      <div className="srf-iterate-roast__header">
        <span className="srf-iterate-roast__avatar" aria-hidden>
          {glyph}
        </span>
        <span className="srf-iterate-roast__title">{headline}</span>
        <span className="srf-iterate-roast__pill">Roast</span>
      </div>
      {body ? <div className="srf-iterate-roast__body">{body}</div> : null}
    </div>
  );
}
