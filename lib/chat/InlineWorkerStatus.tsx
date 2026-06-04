'use client';

/**
 * InlineWorkerStatus — Inline-Banner unterhalb der letzten Bubble, wenn
 * andere Workstreams im aktuellen Workspace im Hintergrund arbeiten.
 *
 * Ergänzt den TopNav `BackgroundActivityIndicator`. User-Befund 2026-05-03:
 * "ich sehe schon wieder nicht ob du arbeitest im lazyOS Chat" — Mobile
 * TopNav-Pulse-Pill war zu klein/unauffällig.
 *
 * Klare Abgrenzung zu existierenden Indikatoren:
 *  - StreamingAssistant      → AKTUELLER Turn (zeigt Caret + Phase-Text)
 *  - TypingIndicator         → Mock/Server-Pending OHNE Stream
 *  - InlineWorkerStatus      → ANDERE Workstreams im selben Workspace
 *  - BackgroundActivityIndicator (TopNav) → Workspace-übergreifend
 *
 * 2026-05-28 — Owner-Fix: Klick oeffnete vorher den ganzen MobileDrawer
 * und scrollte zu drawer-section-activity (direkt ueber Workspaces).
 * Auf Mobile las sich das als „scrollt mich zu den Workspaces" — Owner
 * verlor Chat-Kontext, Pill war „nutzlos". JETZT: Klick oeffnet eine
 * fokussierte Detail-Surface (InlineWorkerStatusDetail) inline am Anker,
 * KEIN Drawer-Dispatch, KEIN Scroll-Sprung.
 *
 * Klein, Token-konform, kein Sticky/Modal/Overlay (das modale ist nur die
 * Detail-Surface, und auch dort: kein doppelter Hintergrund-Layer).
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
  /** Detail-Felder — vom /api/activity/live?detail=1 geliefert. */
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
      // detail=1 → Backend liefert status/stuckSinceMs/stuckReason mit.
      // Backwards-compatible: ohne detail=1 bleibt der Payload identisch.
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
    // Owner-Fix 2026-05-28: NICHT mehr lazyos:drawer:open dispatchen.
    // Inline Detail-Surface oeffnen — kein Drawer, kein Scroll-Sprung.
    const rect = pillRef.current?.getBoundingClientRect() ?? null;
    setAnchorRect(rect);
    setDetailOpen(true);
  }, []);

  const onClose = useCallback((): void => {
    setDetailOpen(false);
  }, []);

  if (items.length === 0) return null;

  // Primary item = jüngstes (items kommen DESC sortiert vom Endpoint)
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
