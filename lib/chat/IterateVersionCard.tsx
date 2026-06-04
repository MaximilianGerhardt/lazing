'use client';

/**
 * IterateVersionCard — Welle 7 (2026-05-01)
 *
 * Shows a single iterate version (V1, V2, V3, …). Kept persistent per
 * `versionN` — on re-synthesis the card replaces itself
 * in-place (see emit-or-update-card with coord={surfaceKind:'iterate-version', versionN}).
 *
 * User finding 2026-05-01: 11 iterate-version events without a surface — only
 * a raw toast. With this card the user sees the V1→V2→V3 progression
 * as a stack in the stream.
 *
 * Pragmatically reduced: no diff view (that would come from the reasoning
 * audit via auditId, would blow up Wave 7). Headline + first bullet/section
 * as a body snippet.
 */

import type { ReactElement } from 'react';

interface Props {
  workstreamId?: string;
  workspaceId?: string;
  versionN?: number;
  text?: string;
  headline?: string;
  costCents?: number;
}

function extractFirstHeadline(text: string | undefined): string {
  if (!text) return '';
  const line = text.split('\n').find((l) => /^##?\s+\S/.test(l));
  if (!line) return text.split('\n')[0]?.slice(0, 80) ?? '';
  return line.replace(/^#{1,2}\s+/, '').slice(0, 80);
}

function extractSnippet(text: string | undefined): string {
  if (!text) return '';
  // Erste 2 Zeilen die kein Heading sind, als Vorschau
  const lines = text
    .split('\n')
    .filter((l) => l.trim().length > 0 && !/^#{1,2}\s/.test(l))
    .slice(0, 3);
  return lines.join(' ').slice(0, 220);
}

export function IterateVersionCard(props: Props): ReactElement {
  const vLabel = typeof props.versionN === 'number' ? `V${props.versionN}` : 'V?';
  const headline = props.headline ?? extractFirstHeadline(props.text) ?? 'Version';
  const snippet = extractSnippet(props.text);
  const cost =
    typeof props.costCents === 'number' && props.costCents > 0
      ? `≈ €${(props.costCents / 100).toFixed(2)}`
      : null;
  return (
    <div className="srf-iterate-version" role="region" aria-label={`Version ${vLabel}`}>
      <div className="srf-iterate-version__header">
        <span className="srf-iterate-version__badge">{vLabel}</span>
        <span className="srf-iterate-version__title">{headline}</span>
        {cost ? <span className="srf-iterate-version__cost">{cost}</span> : null}
      </div>
      {snippet ? <div className="srf-iterate-version__snippet">{snippet}</div> : null}
    </div>
  );
}
