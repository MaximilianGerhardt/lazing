'use client';

/**
 * LiveWorkflowSurface — live-updating 5-step pipeline card in the chat.
 *
 * Rendered when the answer contains a `<surface:workflow-pipeline>` tag
 * (e.g. after a workflow transition by agent or user). It then listens via
 * SSE for further workflow events for the same ticket and advances the
 * state live without a page reload.
 *
 * Steps: draft → review → approved → executed → closed.
 * Rejected: its own banner state.
 *
 * Mount recovery: takes initialState from the surface props. If the ticket
 * is already further along (race), the first SSE event catches up the state
 * automatically.
 *
 * Wave 4 (2026-05-01): inline styles → `.srf-workflow*` CSS classes
 * (see `app/components.css` block B'').
 */

import { useState } from 'react';
import Link from 'next/link';

import {
  PIPELINE_STATES,
  STATE_HINT,
  STATE_LABEL,
  type WorkflowState,
} from '@/lib/approvals/fsm';
import { useEventStream, type LazyEventLike } from './useEventStream';

const STATES = PIPELINE_STATES;

export interface LiveWorkflowSurfaceProps {
  ticketId: string;
  ticketTitle?: string;
  initialState?: string;
  workspaceId?: string;
  href?: string;
}

export function LiveWorkflowSurface(props: LiveWorkflowSurfaceProps) {
  const initial = normalizeState(props.initialState);
  const [state, setState] = useState<WorkflowState>(initial);
  const [bumped, setBumped] = useState<number>(0);

  // SSE listener for workflow events on the same ticket
  useEventStream({
    workspaceId: props.workspaceId,
    onEvent: (ev: LazyEventLike) => {
      if (ev.entityType !== 'ticket') return;
      if (ev.entityId !== props.ticketId) return;
      const next = transitionFromEvent(ev);
      if (!next) return;
      setState(next);
      setBumped((b) => b + 1);
    },
  });

  const isRejected = state === 'rejected';
  const isClosed = state === 'closed';
  const activeIdx = isRejected ? -1 : STATES.indexOf(state as (typeof STATES)[number]);

  const href =
    props.href ?? `/tickets/${encodeURIComponent(props.ticketId)}`;

  return (
    <article className="srf-workflow" aria-label="Workflow-Pipeline">
      <header className="srf-workflow__header">
        <div className="srf-workflow__kicker">WORKFLOW · LIVE</div>
        <div className="srf-workflow__title">
          {props.ticketTitle ?? 'Ticket-Workflow'}
        </div>
        <div className="srf-workflow__hint">{STATE_HINT[state]}</div>
      </header>

      <ol className="srf-workflow__steps" aria-label="Workflow-Schritte">
        {STATES.map((s, i) => {
          const isActive = !isRejected && s === state;
          const isPast = !isRejected && (isClosed || i < activeIdx);
          const stepCls = [
            'srf-workflow__step',
            isPast ? 'srf-workflow__step--past' : '',
            isActive ? 'srf-workflow__step--active' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const numCls = [
            'srf-workflow__num',
            isPast ? 'srf-workflow__num--past' : '',
            isActive ? 'srf-workflow__num--active' : '',
            isActive ? 'lazyos-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const labelCls = [
            'srf-workflow__label',
            isActive ? 'srf-workflow__label--active' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <li
              key={s}
              className={stepCls}
              aria-current={isActive ? 'step' : undefined}
            >
              <span className={numCls} data-bumped={isActive ? bumped : 0}>
                {i + 1}
              </span>
              <span className={labelCls}>{STATE_LABEL[s]}</span>
            </li>
          );
        })}
      </ol>

      {isRejected ? (
        <div className="srf-workflow__rejected" role="status">
          <span style={{ color: 'var(--a-danger)' }}>●</span>
          {STATE_HINT.rejected} — am Ticket reopen oder kommentieren.
        </div>
      ) : null}

      <Link href={href} className="srf-workflow__open press">
        Im Ticket öffnen →
      </Link>

      <style>{pulseKeyframes}</style>
    </article>
  );
}

function normalizeState(s: string | undefined): WorkflowState {
  if (!s) return 'draft';
  const lower = s.toLowerCase();
  if (lower === 'rejected') return 'rejected';
  if ((STATES as readonly string[]).includes(lower)) {
    return lower as (typeof STATES)[number];
  }
  return 'draft';
}

function transitionFromEvent(ev: LazyEventLike): WorkflowState | null {
  // Direkter State im Payload
  const payload = ev.payload ?? {};
  const direct =
    typeof payload.workflowState === 'string'
      ? (payload.workflowState as string)
      : typeof payload.workflow_state === 'string'
        ? (payload.workflow_state as string)
        : null;
  if (direct) return normalizeState(direct);

  // Aus event-type ableiten
  switch (ev.type) {
    case 'approval_requested':
      return 'review';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'executed':
      return 'executed';
    case 'status_changed': {
      const newStatus =
        typeof payload.status === 'string' ? payload.status : null;
      if (newStatus === 'done') return 'closed';
      return null;
    }
    default:
      return null;
  }
}

const pulseKeyframes = `
@keyframes lazyos-wf-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--a-now) 40%, transparent); }
  70% { box-shadow: 0 0 0 12px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.lazyos-pulse {
  animation: lazyos-wf-pulse 1.4s ease-out 1;
}
`;

export default LiveWorkflowSurface;
