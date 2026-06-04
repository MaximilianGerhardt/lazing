'use client';

/**
 * UserCorrectionCard — Welle 7 (2026-05-01)
 *
 * Kompakte Anzeige eines User-Inject während einer Sniper-Pause. User-
 * Befund 2026-05-01: 9 user-correction-Events sind heute nur Toast — ohne
 * Persistenz. Diese Card hält den User-Inject als sichtbaren Anker im
 * Stream, damit klar ist welcher Vn+1 auf welcher Korrektur basiert.
 *
 * Token-bind: alle Werte aus app/components.css `.srf-user-correction__*`.
 */

import type { ReactElement } from 'react';

interface Props {
  workstreamId?: string;
  message?: string;
  injectedAt?: string;
  versionN?: number;
}

function fmtTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

export function UserCorrectionCard(props: Props): ReactElement {
  const t = fmtTime(props.injectedAt);
  const subParts: string[] = ['Du'];
  if (typeof props.versionN === 'number') subParts.push(`vor V${props.versionN}`);
  if (t) subParts.push(t);
  return (
    <div
      className="srf-user-correction"
      role="region"
      aria-label="User-Korrektur"
    >
      <div className="srf-user-correction__header">
        <span className="srf-user-correction__icon" aria-hidden>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </span>
        <span className="srf-user-correction__title">Korrektur</span>
        <span className="srf-user-correction__meta">{subParts.join(' · ')}</span>
      </div>
      {props.message ? (
        <div className="srf-user-correction__body">{props.message}</div>
      ) : null}
    </div>
  );
}
