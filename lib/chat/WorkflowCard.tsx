/**
 * lib/chat/WorkflowCard.tsx
 * --------------------------
 * Sub-Plan 3 · Cluster A (2026-05-01) — pipeline-family merge.
 *
 * Consolidates the historical surface kinds:
 *   - pipeline             (static step array)
 *   - live-pipeline        (auto-dispatch live view)
 *   - workflow-pipeline    (FSM live state)
 *   - iterate-pipeline     (V1..V5 polish loop)
 *
 * Plus the formerly separate iterate-family tags (Cluster B):
 *   - iterate-roast
 *   - iterate-version
 *   - user-correction
 *
 * Called exclusively from SurfaceRenderer.tsx via
 * `<surface:workflow>{phase, ...}</surface:workflow>`. The `phase`
 * discriminator decides which sub-layout is mounted; state
 * slots (`versions[]`) are patched in the same card instead of creating a new
 * history card per Vn — see the replace logic in replace-logic.ts.
 *
 * Backwards-compat: the old kinds remain as deprecated aliases in
 * SURFACE_KINDS and route to the same renderer. Server emission can
 * be migrated to `workflow` piece by piece without a render break.
 *
 * Pure layout component — all side effects (fetch, polling) still
 * live in the underlying cards (LivePipeline, IteratePipelineCard,
 * LiveWorkflowSurface), to which the renderer delegates by phase.
 */

'use client';

import type { ReactNode } from 'react';

import { Pipeline } from '@/lib/ui/pip';
import { IntentPill } from '@/lib/ui/pil';
import type { WorkstreamIntent } from '@/lib/workstreams/intent-classifier';

import { LivePipeline } from './LivePipeline';
import { LiveWorkflowSurface } from './LiveWorkflowSurface';
import { IteratePipelineCard } from './IteratePipelineCard';

export type WorkflowPhase =
  | 'intake'
  | 'plan'
  | 'dispatch'
  | 'execute'
  | 'iterate'
  | 'review'
  | 'done';

export interface WorkflowSubTicketRef {
  id: string;
  title: string;
}

export interface WorkflowStaticStep {
  num: number;
  title: string;
  status: 'done' | 'running' | 'waiting';
  subtitle?: string;
}

export interface WorkflowProps {
  phase: WorkflowPhase;
  workstreamId?: string;
  workspaceId?: string;
  workstreamName?: string;
  /** Statisches Pipeline-Array (Phase = intake/plan/review/done). */
  steps?: WorkflowStaticStep[];
  /** Auto-Dispatch (Phase = dispatch/execute). */
  masterTicketId?: string;
  subTickets?: WorkflowSubTicketRef[];
  /** FSM-Live-State (Phase = execute mit ticketId). */
  ticketId?: string;
  ticketTitle?: string;
  initialState?: string;
  /** Iterate-Loop (Phase = iterate). */
  maxVersion?: number;
  href?: string;
  /**
   * 2026-05-01 — intent marker. Passed through to the sub-card (iterate)
   * or rendered as a fallback step header. Makes workflow cards visually
   * distinguishable (bug-fix vs implementation vs idea).
   */
  intent?: WorkstreamIntent;
}

/**
 * Main dispatcher. A switch over `phase` mounts the correct sub-card.
 *
 * Failure mode: if the fields required per phase are missing, the
 * component falls back to a simple pipeline rendering with a warn step
 * — never null, so the user never sees the card silently disappear.
 */
export function WorkflowCard(props: WorkflowProps): ReactNode {
  const { phase } = props;

  switch (phase) {
    case 'iterate': {
      if (!props.workstreamId || !props.workspaceId) {
        return renderFallbackSteps(
          props.steps,
          'iterate',
          props.workstreamName,
          props.intent,
        );
      }
      return (
        <IteratePipelineCard
          workstreamId={props.workstreamId}
          workspaceId={props.workspaceId}
          workstreamName={props.workstreamName}
          maxVersion={props.maxVersion}
          intent={props.intent}
        />
      );
    }
    case 'dispatch':
    case 'execute': {
      // Bevorzugt Live-Pipeline (Sub-Tickets vorhanden), fallback FSM-View.
      if (
        props.workstreamId &&
        props.workspaceId &&
        props.masterTicketId &&
        props.subTickets &&
        props.subTickets.length > 0
      ) {
        return (
          <LivePipeline
            workstreamId={props.workstreamId}
            workspaceId={props.workspaceId}
            masterTicketId={props.masterTicketId}
            subTickets={props.subTickets}
            href={
              props.href ??
              `/tickets/${encodeURIComponent(props.masterTicketId)}`
            }
          />
        );
      }
      if (props.ticketId) {
        return (
          <LiveWorkflowSurface
            ticketId={props.ticketId}
            ticketTitle={props.ticketTitle}
            initialState={props.initialState ?? 'draft'}
            workspaceId={props.workspaceId}
            href={props.href}
          />
        );
      }
      return renderFallbackSteps(
        props.steps,
        phase,
        props.workstreamName,
        props.intent,
      );
    }
    case 'intake':
    case 'plan':
    case 'review':
    case 'done':
    default:
      return renderFallbackSteps(
        props.steps,
        phase,
        props.workstreamName,
        props.intent,
      );
  }
}

function renderFallbackSteps(
  steps: WorkflowStaticStep[] | undefined,
  phase: WorkflowPhase,
  name?: string,
  intent?: WorkstreamIntent,
): ReactNode {
  const safe: WorkflowStaticStep[] =
    steps && steps.length > 0
      ? steps
      : [
          {
            num: 1,
            title: name ? `${name} · Phase ${phase}` : `Phase ${phase}`,
            status: phase === 'done' ? 'done' : 'running',
            subtitle: 'Keine Detail-Schritte verfuegbar',
          },
        ];
  if (intent) {
    return (
      <div className="srf-workflow-fallback">
        <div className="srf-workflow-fallback__header">
          <IntentPill intent={intent} />
        </div>
        <Pipeline steps={safe} />
      </div>
    );
  }
  return <Pipeline steps={safe} />;
}
