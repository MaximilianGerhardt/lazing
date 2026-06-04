'use client';

/**
 * InlineWorkerStatus — an inline banner below the last bubble when
 * other workstreams in the current workspace are working in the background.
 *
 * Complements the TopNav `BackgroundActivityIndicator`. User finding 2026-05-03:
 * "ich sehe schon wieder nicht ob du arbeitest im lazyOS Chat" — the mobile
 * TopNav pulse pill was too small/inconspicuous.
 *
 * Clear distinction from existing indicators:
 *  - StreamingAssistant      → CURRENT turn (shows caret + phase text)
 *  - TypingIndicator         → mock/server-pending WITHOUT a stream
 *  - InlineWorkerStatus      → OTHER workstreams in the same workspace
 *  - BackgroundActivityIndicator (TopNav) → across workspaces
 *
 * 2026-05-28 — owner fix: a click previously opened the whole MobileDrawer
 * and scrolled to drawer-section-activity (directly above workspaces).
 * On mobile this read as „it scrolls me to the workspaces" — the owner
 * lost the chat context, the pill was „useless". NOW: a click opens a
 * focused detail surface (InlineWorkerStatusDetail) inline at the anchor,
 * NO drawer dispatch, NO scroll jump.
 *
 * Small, token-compliant, no sticky/modal/overlay (the modal is only the
 * detail surface, and even there: no double background layer).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatDur } from './format-duration';
import {
  InlineWorkerStatusDetail,
  type DetailActivityItem,
} from './InlineWorkerStatusDetail';

interface ActivityItem {
  type: 'workstream' | 'workflow' | 'routine' | 'sub-workstream';
  id: string;
  label: string;
  phase: string | null;
  lastTickMs: number | null;
  workspaceId: string;
  /** Detail fields — delivered by /api/activity/live?detail=1. */
  status?: 'active' | 'paused' | 'stuck' | null;
  stuckSinceMs?: number | null;
  stuckReason?: string | null;
}

interface ActivityResponse {
  ok: boolean;
  now: number;
  running: number;
  paused: number;
  stuck: number;
  cronSoon: number;
  items: ActivityItem[];
}

const POLL_MS = 15_000;

function describePhase(item: ActivityItem): string {
  if (item.type === 'sub-workstream') return 'Sub-Agent · ' + (item.phase ?? 'läuft');
  if (item.type === 'workflow') return 'Workflow · ' + (item.phase ?? 'running');
  if (item.type === 'routine') return 'Cron · ' + (item.phase ?? 'scheduled');
  return item.phase ?? 'aktiv';
}

export function InlineWorkerStatus({
  workspaceId,
  excludeWorkstreamIds,
}: {
  workspaceId: string;
  excludeWorkstreamIds?: readonly string[];
}): React.JSX.Element | null {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  const [detailOpen, setDetailOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const inflightRef = useRef<AbortController | null>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    const exclude = new Set(excludeWorkstreamIds ?? []);

    const tick = (): void => {
      inflightRef.current?.abort();
      const ctrl = new AbortController();
      inflightRef.current = ctrl;
      // detail=1 → the backend also delivers status/stuckSinceMs/stuckReason.
      // Backwards-compatible: without detail=1 the payload stays identical.
      fetch('/api/activity/live?detail=1', {
        cache: 'no-store',
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<ActivityResponse>) : null))
        .then((body) => {
          if (cancelled) return;
          if (!body || body.ok === false) {
            setItems([]);
            return;
          }
          const filtered = body.items.filter(
            (it) =>
              it.workspaceId === workspaceId &&
              !exclude.has(it.id) &&
              (it.type === 'workstream' ||
                it.type === 'sub-workstream' ||
                it.type === 'workflow'),
          );
          setItems(filtered);
          setNow(Date.now());
        })
        .catch(() => {
          if (cancelled) return;
          setItems([]);
        });
    };

    tick();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, POLL_MS);

    const onVis = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      inflightRef.current?.abort();
    };
  }, [workspaceId, excludeWorkstreamIds]);

  const detailItems = useMemo<readonly DetailActivityItem[]>(
    () =>
      items.map((it) => ({
        type: it.type,
        id: it.id,
        label: it.label,
        phase: it.phase,
        lastTickMs: it.lastTickMs,
        workspaceId: it.workspaceId,
        status: it.status ?? null,
        stuckSinceMs: it.stuckSinceMs ?? null,
        stuckReason: it.stuckReason ?? null,
      })),
    [items],
  );

  const onClick = useCallback((): void => {
    // Owner fix 2026-05-28: no longer dispatch lazyos:drawer:open.
    // Open the inline detail surface — no drawer, no scroll jump.
    const rect = pillRef.current?.getBoundingClientRect() ?? null;
    setAnchorRect(rect);
    setDetailOpen(true);
  }, []);

  const onClose = useCallback((): void => {
    setDetailOpen(false);
  }, []);

  if (items.length === 0) return null;

  // Primary item = newest (items come DESC-sorted from the endpoint)
  const primary = items[0];
  const more = items.length - 1;
  const dur = formatDur(primary.lastTickMs, now);

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        onClick={onClick}
        className="inline-worker-status"
        aria-label={`${items.length} Hintergrund-Aktivitäten in diesem Workspace. Klicken für Details.`}
        aria-haspopup="dialog"
        aria-expanded={detailOpen}
      >
        <span className="inline-worker-status__pulse" aria-hidden="true" />
        <span className="inline-worker-status__label">
          {describePhase(primary)}
          {dur ? <span className="inline-worker-status__dur"> · {dur}</span> : null}
          {more > 0 ? (
            <span className="inline-worker-status__more"> · +{more}</span>
          ) : null}
        </span>
        <span className="inline-worker-status__chev" aria-hidden="true">
          ›
        </span>
      </button>
      <InlineWorkerStatusDetail
        open={detailOpen}
        items={detailItems}
        now={now}
        onClose={onClose}
        anchorRect={anchorRect}
      />
    </>
  );
}

export default InlineWorkerStatus;
