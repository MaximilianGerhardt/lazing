'use client';

/**
 * LoopPhaseCard — Welle 7 (2026-05-01)
 *
 * Generic Card für Loop-Phase-Events des 3-Tier-Coding-Loops:
 *   - auto-dispatch-stage          (Stage executed: senior-dev/reviewer/critic)
 *   - auto-dispatch-stage-retry    (Stage retry nach Rate-Limit)
 *   - auto-dispatch-overview       (Loop gestartet, n Sub-Tickets gequeued)
 *   - auto-dispatch-pause          (Loop pausiert wegen TPM-Budget)
 *   - tier-output                  (Agent eines Tiers liefert Output)
 *   - iterate-resumed              (Loop nach Sniper-Inject fortgesetzt)
 *   - sniper-pause-start           (Pause vor Vn+1 für User-Inject)
 *
 * User-Befund 2026-05-01: 10 von 13 Demo Fitness-Loop-Kinds hatten KEINE
 * dedizierte Surface — nur Toast-Ersatz oder null. Diese Card schließt die
 * Coverage-Lücke. Pro Kind ein eigenes Phase-Glyph + Phase-Label, gemeinsame
 * Layout-Struktur (Header-Pill + Body + optionale Meta-Zeile).
 *
 * Token-bind, Apple-Pure: keine Inline-Styles, alle Farben/Radien aus
 * --line-2/--sheet-2/--ink/--a-now Tokens. Mount-Animation via srf-pop
 * (siehe app/components.css B' · SRF).
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
  /** z.B. 'senior-dev', 'code-reviewer', 'critic'. */
  stage?: string;
  /** z.B. 'opus' / 'sonnet' / 'haiku'. */
  tier?: string;
  /** Index innerhalb des Tiers (0..N-1). */
  agentIdx?: number;
  /** Stage-Index in der Master-Pipeline (0,1,2). */
  stageIdx?: number;
  attempt?: number;
  maxAttempts?: number;
  /** Wartezeit in ms bei Retry/Pause. */
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
