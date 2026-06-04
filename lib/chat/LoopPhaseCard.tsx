'use client';

/**
 * LoopPhaseCard — Wave 7 (2026-05-01)
 *
 * Generic card for loop-phase events of the 3-tier coding loop:
 *   - auto-dispatch-stage          (stage executed: senior-dev/reviewer/critic)
 *   - auto-dispatch-stage-retry    (stage retry after rate limit)
 *   - auto-dispatch-overview       (loop started, n sub-tickets queued)
 *   - auto-dispatch-pause          (loop paused due to TPM budget)
 *   - tier-output                  (agent of a tier delivers output)
 *   - iterate-resumed              (loop resumed after sniper inject)
 *   - sniper-pause-start           (pause before Vn+1 for user inject)
 *
 * User finding 2026-05-01: 10 of 13 demo fitness-loop kinds had NO
 * dedicated surface — only a toast substitute or null. This card closes the
 * coverage gap. Per kind its own phase glyph + phase label, shared
 * layout structure (header pill + body + optional meta line).
 *
 * Token bind, Apple-pure: no inline styles, all colors/radii from
 * --line-2/--sheet-2/--ink/--a-now tokens. Mount animation via srf-pop
 * (see app/components.css B' · SRF).
 */

import type { ReactElement } from 'react';

export type LoopPhaseKind =
  | 'auto-dispatch-stage'
  | 'auto-dispatch-stage-retry'
  | 'auto-dispatch-overview'
  | 'auto-dispatch-pause'
  | 'tier-output'
  | 'iterate-resumed'
  | 'sniper-pause-start';

interface Props {
  kind: LoopPhaseKind;
  workstreamId?: string;
  workspaceId?: string;
  /** e.g. 'senior-dev', 'code-reviewer', 'critic'. */
  stage?: string;
  /** e.g. 'opus' / 'sonnet' / 'haiku'. */
  tier?: string;
  /** Index within the tier (0..N-1). */
  agentIdx?: number;
  /** Stage index in the master pipeline (0,1,2). */
  stageIdx?: number;
  attempt?: number;
  maxAttempts?: number;
  /** Wait time in ms on retry/pause. */
  waitMs?: number;
  versionN?: number;
  text?: string;
  reason?: string;
  actor?: string;
}

const PHASE_META: Record<
  LoopPhaseKind,
  { glyph: string; label: string; tone: 'info' | 'warn' | 'ok' }
> = {
  'auto-dispatch-stage': { glyph: '▸', label: 'Stage', tone: 'info' },
  'auto-dispatch-stage-retry': { glyph: '↻', label: 'Retry', tone: 'warn' },
  'auto-dispatch-overview': { glyph: '≡', label: 'Loop gestartet', tone: 'info' },
  'auto-dispatch-pause': { glyph: '‖', label: 'Pausiert', tone: 'warn' },
  'tier-output': { glyph: '◎', label: 'Tier-Output', tone: 'ok' },
  'iterate-resumed': { glyph: '↪', label: 'Fortgesetzt', tone: 'ok' },
  'sniper-pause-start': { glyph: '◷', label: 'Sniper-Pause', tone: 'warn' },
};

function fmtSeconds(ms?: number): string | null {
  if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m}min` : `${m}m ${r}s`;
}

export function LoopPhaseCard(props: Props): ReactElement {
  const meta = PHASE_META[props.kind];
  const headlineParts: string[] = [meta.label];
  if (props.stage) headlineParts.push(props.stage);
  else if (props.tier) {
    const tail = typeof props.agentIdx === 'number' ? ` #${props.agentIdx + 1}` : '';
    headlineParts.push(`${props.tier}${tail}`);
  }
  if (typeof props.versionN === 'number') headlineParts.push(`V${props.versionN}`);
  const headline = headlineParts.join(' · ');

  const subParts: string[] = [];
  if (typeof props.attempt === 'number' && typeof props.maxAttempts === 'number') {
    subParts.push(`Versuch ${props.attempt}/${props.maxAttempts}`);
  }
  const wait = fmtSeconds(props.waitMs);
  if (wait) subParts.push(`wartet ${wait}`);
  if (typeof props.stageIdx === 'number') subParts.push(`Stage-Idx ${props.stageIdx + 1}`);
  if (props.actor) subParts.push(props.actor);

  const body = props.text ?? props.reason ?? null;

  return (
    <div
      className="srf-loop-phase"
      data-kind={props.kind}
      data-tone={meta.tone}
      role="status"
      aria-label={`${meta.label}${props.stage ? ': ' + props.stage : ''}`}
    >
      <div className="srf-loop-phase__header">
        <span className="srf-loop-phase__glyph" aria-hidden>
          {meta.glyph}
        </span>
        <span className="srf-loop-phase__title">{headline}</span>
        {subParts.length > 0 ? (
          <span className="srf-loop-phase__pill">{subParts.join(' · ')}</span>
        ) : null}
      </div>
      {body ? <div className="srf-loop-phase__body">{body}</div> : null}
    </div>
  );
}
