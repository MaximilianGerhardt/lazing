'use client';

/**
 * LiveSwarm — live-updating heatmap of tier-spawn activity.
 *
 * Takes a workstream + expected tier-mix counts and renders a
 * grid with as many cells as agents are planned. Via useEventStream,
 * incoming `commented` events on the master ticket with
 * `payload.kind='tier-output'` are picked up and update the
 * cells:
 *   empty       → not started yet
 *   running     → no output yet (initial — phase D does clustering later)
 *   consensus   → text present, counts as a valid contribution
 *   outlier     → rateLimited or error
 *   median      → synthesis output (highlighted)
 */

import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react';

import { Heatmap } from '@/lib/ui/chr';
import { useEventStream, type LazyEventLike } from './useEventStream';

interface Props {
  workstreamId: string;
  workspaceId: string;
  ticketId?: string;
  tierMix: { opus: number; sonnet: number; haiku: number };
  href?: string;
}

interface CellState {
  status: 'running' | 'consensus' | 'outlier' | 'median';
  tier: 'opus' | 'sonnet' | 'haiku';
}

function LiveSwarmImpl({
  workstreamId,
  workspaceId,
  ticketId,
  tierMix,
  href,
}: Props) {
  // Initial: all slots as "running" (waiting + already triggered).
  const initialCells = useMemo<CellState[]>(() => {
    const out: CellState[] = [];
    for (let i = 0; i < tierMix.opus; i++) out.push({ status: 'running', tier: 'opus' });
    for (let i = 0; i < tierMix.sonnet; i++) out.push({ status: 'running', tier: 'sonnet' });
    for (let i = 0; i < tierMix.haiku; i++) out.push({ status: 'running', tier: 'haiku' });
    return out;
  }, [tierMix]);

  const [cells, setCells] = useState<CellState[]>(initialCells);
  const [synthesisDone, setSynthesisDone] = useState(false);

  useEffect(() => {
    setCells(initialCells);
    setSynthesisDone(false);
  }, [initialCells]);

  // Mount recovery: on re-open of the PWA we fetch the timeline of the
  // master ticket and reconstruct the cell state from already-emitted
  // tier-output events (without waiting for an SSE replay).
  useEffect(() => {
    if (!ticketId) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(
          `/api/tickets/${encodeURIComponent(ticketId)}/timeline`,
          { cache: 'no-store' },
        );
        if (!resp.ok) return;
        // Bug fix 2026-04-26: endpoint returns `timeline`, not `events`.
        // Previously LiveSwarm read `data.events` → undefined → mount recovery
        // found 0 historical tier-outputs → the heatmap showed only the 2-3
        // cells that arrived LIVE via SSE after mount ("2/20 stuck"),
        // all others falsely stayed on "running". Plus: events
        // can be named `eventType` OR `type` depending on the source.
        const data = (await resp.json()) as {
          timeline?: Array<{
            eventType?: string;
            type?: string;
            payload?: Record<string, unknown>;
          }>;
          events?: Array<{
            eventType?: string;
            type?: string;
            payload?: Record<string, unknown>;
          }>;
        };
        if (cancelled) return;
        const events = Array.isArray(data.timeline)
          ? data.timeline
          : Array.isArray(data.events)
            ? data.events
            : [];
        let synthFlag = false;
        setCells((prev) => {
          const next = [...prev];
          for (const ev of events) {
            // Defensive: timeline can provide `eventType` (DB shape) OR `type`
            // (SSE LazyEventLike shape), depending on the bridge path.
            const evType = ev.eventType ?? ev.type ?? '';
            if (evType !== 'commented') continue;
            const p = (ev.payload ?? {}) as Record<string, unknown>;
            if (p.workstreamId !== workstreamId) continue;
            const kind = typeof p.kind === 'string' ? p.kind : '';
            if (kind === 'tier-output') {
              const tier = p.tier as CellState['tier'];
              const idx = typeof p.agentIdx === 'number' ? p.agentIdx : 0;
              const rateLimited = p.rateLimited === true;
              const cellIdx = findCellIndex(next, tier, idx);
              if (cellIdx >= 0) {
                next[cellIdx] = {
                  tier,
                  status: rateLimited ? 'outlier' : 'consensus',
                };
              }
            } else if (kind === 'synthesis') {
              synthFlag = true;
            }
          }
          return next;
        });
        if (synthFlag) setSynthesisDone(true);
      } catch {
        /* silent — SSE may deliver the updates */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ticketId, workstreamId]);

  const handleEvent = (ev: LazyEventLike): void => {
    if (ev.type !== 'commented') return;
    if (ev.entityId !== ticketId && ticketId) return;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (p.workstreamId !== workstreamId) return;
    const kind = typeof p.kind === 'string' ? p.kind : '';
    const tier = (typeof p.tier === 'string' ? p.tier : '') as CellState['tier'];
    if (kind === 'tier-output') {
      const idx = typeof p.agentIdx === 'number' ? p.agentIdx : 0;
      const rateLimited = p.rateLimited === true;
      setCells((prev) => {
        const next = [...prev];
        const cellIdx = findCellIndex(next, tier, idx);
        if (cellIdx >= 0) {
          next[cellIdx] = {
            tier,
            status: rateLimited ? 'outlier' : 'consensus',
          };
        }
        return next;
      });
    } else if (kind === 'synthesis') {
      setSynthesisDone(true);
    }
  };

  useEventStream({
    workspaceId,
    onEvent: handleEvent,
    enabled: true,
    includeInitial: true,
  });

  const total = cells.length;
  const done = cells.filter((c) => c.status !== 'running').length;
  const status = synthesisDone ? 'Synthesis fertig' : `${done}/${total} Agents fertig`;

  const heatCells = cells.map((c) => ({ variant: cellVariant(c.status) }));

  return (
    <div style={wrapStyle}>
      <div style={headerStyle}>
        <span style={tierBadge('var(--a-now)')}>Opus×{tierMix.opus}</span>
        <span style={tierBadge('var(--a-warn)')}>Sonnet×{tierMix.sonnet}</span>
        <span style={tierBadge('var(--ink-3)')}>Haiku×{tierMix.haiku}</span>
        <span style={statusStyle}>{status}</span>
      </div>
      <Heatmap
        title={synthesisDone ? 'Konsens erreicht' : 'Schwarm laeuft'}
        value={`${done}/${total}`}
        sub={
          synthesisDone
            ? 'Lead-Agent hat synthetisiert'
            : 'tier-outputs trudeln ein'
        }
        cells={heatCells}
      />
      {href ? (
        <a style={linkStyle} href={href}>
          → Workstream-Detail
        </a>
      ) : null}
    </div>
  );
}

function findCellIndex(
  cells: CellState[],
  tier: CellState['tier'],
  agentIdx: number,
): number {
  let counter = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].tier === tier) {
      if (counter === agentIdx) return i;
      counter += 1;
    }
  }
  return -1;
}

function cellVariant(
  status: CellState['status'],
): 'consensus' | 'median' | 'outlier' | 'running' | 'empty' {
  switch (status) {
    case 'consensus':
      return 'consensus';
    case 'median':
      return 'median';
    case 'outlier':
      return 'outlier';
    case 'running':
      return 'running';
    default:
      return 'empty';
  }
}

const wrapStyle: CSSProperties = {
  maxWidth: 560,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

function tierBadge(color: string): CSSProperties {
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    background: `color-mix(in oklab, ${color} 14%, transparent)`,
    color,
    letterSpacing: '0.04em',
  };
}

const statusStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.04em',
};

const linkStyle: CSSProperties = {
  fontSize: 12,
  color: 'var(--a-now)',
  textDecoration: 'none',
  alignSelf: 'flex-end',
};

// Sub-Plan E (2026-04-30) — React.memo. tierMix is a new object per
// parse pass; flat 3 number fields are enough for equality.
function liveSwarmPropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.workstreamId === next.workstreamId &&
    prev.workspaceId === next.workspaceId &&
    prev.ticketId === next.ticketId &&
    prev.href === next.href &&
    prev.tierMix.opus === next.tierMix.opus &&
    prev.tierMix.sonnet === next.tierMix.sonnet &&
    prev.tierMix.haiku === next.tierMix.haiku
  );
}

export const LiveSwarm = memo(LiveSwarmImpl, liveSwarmPropsEqual);
