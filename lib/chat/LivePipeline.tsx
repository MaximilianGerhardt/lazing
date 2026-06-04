'use client';

/**
 * LivePipeline — Phase WSC.1 (2026-04-26)
 *
 * Live card in the chat: shows the auto-dispatch of a master with all
 * sub-tickets × 3 stages (senior-dev → code-reviewer → critic).
 *
 * Flow:
 *   1. The auto-dispatch spawner emits 1× commented kind=auto-dispatch-overview
 *      on the master with a subTicketIds list.
 *   2. event-to-surface maps that onto <surface:live-pipeline>.
 *   3. ChatShell renders the card. This component subscribes to
 *      useEventStream and reacts to:
 *        - commented kind=auto-dispatch-stage → marks (sub, stage) as done
 *        - updated transition=auto_close_after_subs on the master → done state
 *        - updated transition=auto_dispatch_failed → failed state per sub
 *   4. On the done state: the card shows "all done", link to the master.
 *
 * The user thus sees WITHOUT clicking the master ticket whether the system is
 * still working or finished. Direct-query point: on a 'critic' stage with
 * a @max mention in the output, the user can reply directly in the chat (Phase WSC.2).
 *
 * Wave 3.4 — Refactored: inline styles → CSS classes + token bind.
 *   - 2px slider bug fixed: → var(--radius-xs) (5px, deliberate upgrade)
 *   - 12px card radius → var(--radius-md)
 */

import { memo, useEffect, useState } from 'react';

import { useEventStream, type LazyEventLike } from './useEventStream';

const STAGES = ['senior-dev', 'code-reviewer', 'critic'] as const;
type Stage = (typeof STAGES)[number];

type CellStatus = 'pending' | 'running' | 'done' | 'failed';

interface SubState {
  id: string;
  title: string;
  stages: Record<Stage, CellStatus>;
}

interface Props {
  workstreamId: string;
  workspaceId: string;
  masterTicketId: string;
  subTickets: Array<{ id: string; title: string }>;
  href?: string;
}

function LivePipelineImpl({
  workstreamId,
  workspaceId,
  masterTicketId,
  subTickets,
  href,
}: Props) {
  const [subs, setSubs] = useState<SubState[]>(() =>
    subTickets.map((s) => ({
      id: s.id,
      title: s.title,
      stages: {
        'senior-dev': 'pending',
        'code-reviewer': 'pending',
        critic: 'pending',
      },
    })),
  );
  const [allDone, setAllDone] = useState(false);

  // Mount recovery: load the timeline of the sub-tickets, apply past
  // auto-dispatch-stage events.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const sub of subTickets) {
        try {
          const resp = await fetch(
            `/api/tickets/${encodeURIComponent(sub.id)}/timeline`,
            { cache: 'no-store' },
          );
          if (!resp.ok) continue;
          const data = (await resp.json()) as {
            timeline?: Array<{
              eventType?: string;
              type?: string;
              payload?: Record<string, unknown>;
            }>;
          };
          if (cancelled) return;
          const events = Array.isArray(data.timeline) ? data.timeline : [];
          for (const ev of events) {
            const evType = ev.eventType ?? ev.type ?? '';
            if (evType !== 'commented') continue;
            const p = (ev.payload ?? {}) as Record<string, unknown>;
            const kind = typeof p.kind === 'string' ? p.kind : '';
            if (kind !== 'auto-dispatch-stage') continue;
            const stage = (typeof p.stage === 'string' ? p.stage : '') as Stage;
            if (!STAGES.includes(stage)) continue;
            setSubs((prev) =>
              prev.map((x) =>
                x.id === sub.id
                  ? { ...x, stages: { ...x.stages, [stage]: 'done' } }
                  : x,
              ),
            );
          }
        } catch {
          // ignore
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subTickets]);

  // Live-Stream
  const handleEvent = (ev: LazyEventLike): void => {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === 'commented') {
      const kind = typeof p.kind === 'string' ? p.kind : '';
      if (kind === 'auto-dispatch-stage') {
        const stage = (typeof p.stage === 'string' ? p.stage : '') as Stage;
        if (!STAGES.includes(stage)) return;
        const subId = ev.entityId;
        if (!subId) return;
        setSubs((prev) =>
          prev.map((x) =>
            x.id === subId
              ? { ...x, stages: { ...x.stages, [stage]: 'done' } }
              : x,
          ),
        );
      }
    } else if (ev.type === 'updated') {
      const transition = typeof p.transition === 'string' ? p.transition : '';
      if (transition === 'auto_close_after_subs' && ev.entityId === masterTicketId) {
        setAllDone(true);
      } else if (transition === 'auto_dispatch_failed' && ev.entityId) {
        const failedStage = (typeof p.failedStage === 'string' ? p.failedStage : '') as Stage;
        if (STAGES.includes(failedStage)) {
          const failedSubId = ev.entityId;
          setSubs((prev) =>
            prev.map((x) =>
              x.id === failedSubId
                ? { ...x, stages: { ...x.stages, [failedStage]: 'failed' } }
                : x,
            ),
          );
        }
      }
    }
  };

  useEventStream({
    workspaceId,
    onEvent: handleEvent,
    enabled: true,
    includeInitial: true,
  });

  const totalStages = subs.length * 3;
  const doneStages = subs.reduce(
    (acc, s) => acc + STAGES.filter((st) => s.stages[st] === 'done').length,
    0,
  );

  return (
    <div className="srf-pipeline">
      <div className="srf-pipeline__header">
        <DotIcon variant={allDone ? 'ok' : 'running'} />
        <span className="srf-pipeline__title">Auto-Pipeline</span>
        <span className="srf-pipeline__pill">
          {allDone ? 'Alle erledigt' : `${doneStages}/${totalStages} Stages`}
        </span>
      </div>
      <div className="srf-pipeline__body">
        {subs.length} Sub-Tickets · 3 Stages pro Sub (senior-dev →
        code-reviewer → critic). Du musst nichts tun — ich melde mich wenn alles
        durch ist.
      </div>
      <div className="srf-pipeline__grid-wrap">
        <div className="srf-pipeline__legend">
          {STAGES.map((s) => (
            <span key={s} className="srf-pipeline__legend-item">
              {s}
            </span>
          ))}
        </div>
        <div className="srf-pipeline__grid">
          {subs.map((sub) => (
            <SubRow key={sub.id} sub={sub} />
          ))}
        </div>
      </div>
      {href ? (
        <a href={href} className="srf-pipeline__link">
          {allDone ? 'Master ansehen →' : 'Details ansehen →'}
        </a>
      ) : null}
    </div>
  );
}

function SubRow({ sub }: { sub: SubState }) {
  return (
    <div className="srf-pipeline__sub-row">
      <div className="srf-pipeline__sub-title" title={sub.title}>
        {sub.title.length > 60 ? `${sub.title.slice(0, 57)}…` : sub.title}
      </div>
      <div className="srf-pipeline__cells-row">
        {STAGES.map((stage) => (
          <Cell key={stage} status={sub.stages[stage]} stage={stage} />
        ))}
      </div>
    </div>
  );
}

function Cell({ status, stage }: { status: CellStatus; stage: Stage }) {
  const cls =
    status === 'pending'
      ? 'srf-pipeline__cell'
      : `srf-pipeline__cell srf-pipeline__cell--${status}`;
  return (
    <span
      aria-label={`${stage} · ${status}`}
      title={`${stage} · ${status}`}
      className={cls}
    />
  );
}

function DotIcon({ variant }: { variant: 'ok' | 'running' }) {
  const cls =
    variant === 'running'
      ? 'srf-pipeline__dot srf-pipeline__dot--running'
      : 'srf-pipeline__dot';
  return <span aria-hidden className={cls} />;
}

// Sub-Plan E (2026-04-30) — React.memo. subTickets is an array — JSON.stringify
// as a pragmatic choice (same rationale as ConsensusActionCard).
function livePipelinePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.workstreamId === next.workstreamId &&
    prev.workspaceId === next.workspaceId &&
    prev.masterTicketId === next.masterTicketId &&
    prev.href === next.href &&
    JSON.stringify(prev.subTickets) === JSON.stringify(next.subTickets)
  );
}

export const LivePipeline = memo(LivePipelineImpl, livePipelinePropsEqual);
