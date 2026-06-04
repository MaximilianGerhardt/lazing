'use client';

/**
 * useEventStream — SSE-Hook auf `/api/events/stream`.
 *
 * Connects the chat to the live event feed: tickets are created,
 * approval requests come in, heartbeats go stale, routines fire
 * → everything lands as a system message in the chat (as a surface card).
 *
 * Mounting strategy:
 *   - Auto-reconnect with backoff (1s → 2s → 4s → max 30s).
 *   - Pauses when `document.hidden` (saves bandwidth on PWA in the background).
 *   - De-duplicates per event.id via an internal Set.
 *
 * onEvent is also called for already-replayed events from the initial window.
 * If that is not wanted, the caller filters by timestamp.
 */

import { useEffect, useRef } from 'react';

export interface LazyEventLike {
  id?: string;
  type?: string;
  entityType?: string;
  entityId?: string;
  segmentId?: string;
  workspaceId?: string;
  actor?: string;
  sensitivity?: 'low' | 'medium' | 'high';
  ts?: number;
  payload?: Record<string, unknown>;
}

export interface UseEventStreamOptions {
  /** Optional filter — only events where payload.workspaceId == workspaceId get passed through. */
  workspaceId?: string;
  onEvent: (event: LazyEventLike) => void;
  /** Treat initial-replay events same as live? Default false (skip until first non-replay). */
  includeInitial?: boolean;
  enabled?: boolean;
}

export function useEventStream(opts: UseEventStreamOptions): void {
  const {
    workspaceId,
    onEvent,
    includeInitial = false,
    enabled = true,
  } = opts;

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const seenIds = useRef<Set<string>>(new Set());
  const esRef = useRef<EventSource | null>(null);
  const backoffRef = useRef(1000);
  const initialWindowDone = useRef(false);

  // Bug-3-Fix 2026-05-25: workspaceId is NO LONGER kept as a useEffect
  // dependency that rebuilds the EventSource. The EventSource is a
  // singleton TCP connection to the server — closing and reopening it on a
  // workspace switch causes a visual break of the
  // running stream (the SSE reconnect takes 1–3s, during which the
  // in-flight turn visually disappears). Instead: keep workspaceId in
  // a ref; the onmessage handler filters foreign events live.
  // Race-safe: if the user switched quickly and frames of the old workspace
  // are still in transit, they are silently discarded by the filter.
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;

    // H5-Fix: reset initialWindowDone on every effect (re-)activation.
    // If the hook is deactivated (enabled=false) and later reactivated,
    // a fresh EventSource is built — the server resends the
    // initial replay burst. If initialWindowDone stayed true, this
    // burst would run through unfiltered (old events doubled). Reset + the 1.2s
    // timer below re-arm the initial window cleanly.
    initialWindowDone.current = false;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled) return;
      if (document.hidden) {
        // Defer until tab is visible again — visibilitychange-handler re-runs connect()
        return;
      }
      const url = '/api/events/stream';
      try {
        const es = new EventSource(url, { withCredentials: true });
        esRef.current = es;

        es.onopen = () => {
          backoffRef.current = 1000;
        };

        es.onmessage = (ev) => {
          try {
            const raw = JSON.parse(ev.data) as Record<string, unknown>;
            // Normalization: the wire format is `LazyEvent` with
            // `eventType`/`createdAt`/`segmentId`. But `LazyEventLike`
            // expects `type`/`ts`/`workspaceId`. We map
            // once so downstream code can use both fields.
            const data: LazyEventLike = {
              ...(raw as LazyEventLike),
              type:
                (raw as { type?: string }).type ??
                ((raw as { eventType?: string }).eventType as string | undefined),
              ts:
                (raw as { ts?: number }).ts ??
                ((raw as { createdAt?: number }).createdAt as number | undefined),
              workspaceId:
                (raw as { workspaceId?: string }).workspaceId ??
                ((raw as { segmentId?: string }).segmentId as
                  | string
                  | undefined),
            };

            // De-dup
            if (data.id) {
              if (seenIds.current.has(data.id)) return;
              seenIds.current.add(data.id);
              // Cap set size to avoid unbounded growth
              if (seenIds.current.size > 500) {
                const first = seenIds.current.values().next().value;
                if (first) seenIds.current.delete(first);
              }
            }

            // Bug-3-Fix: read the workspace filter from the ref (current value
            // without a dependency change). Events of foreign workspaces are
            // silently discarded — the onmessage closure sees the latest value via
            // workspaceIdRef, never a stale closure capture.
            const currentWsId = workspaceIdRef.current;
            if (currentWsId) {
              const evWs =
                data.workspaceId ??
                (data.payload &&
                  typeof data.payload === 'object' &&
                  'workspaceId' in data.payload &&
                  typeof data.payload.workspaceId === 'string'
                  ? (data.payload.workspaceId as string)
                  : undefined);
              if (evWs && evWs !== currentWsId) return;
            }

            // Skip initial-replay batch by default (first ~0.5s burst).
            // Phase MS: chat_message_* events ALWAYS pass through,
            // even in the initial window — otherwise the client sees
            // realtime events twice on reconnect (once from the history
            // GET, once from the replay burst). But since the history GET
            // contains only `chat_message_*` and the burst is also
            // de-duplicated via event.id, this is safe.
            const t =
              typeof data.type === 'string' ? data.type : undefined;
            const isChatMessage =
              t === 'chat_message_sent' || t === 'chat_message_completed';
            if (!isChatMessage && !includeInitial && !initialWindowDone.current) {
              return;
            }

            onEventRef.current(data);
          } catch {
            // Malformed line — ignore
          }
        };

        es.onerror = () => {
          try {
            es.close();
          } catch {
            // ignore
          }
          if (esRef.current === es) {
            esRef.current = null;
          }
          if (cancelled) return;
          // Reconnect with backoff
          const wait = Math.min(backoffRef.current, 30_000);
          backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
          reconnectTimer = setTimeout(connect, wait);
        };
      } catch {
        // EventSource-Ctor threw — try again with backoff
        const wait = Math.min(backoffRef.current, 30_000);
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
        reconnectTimer = setTimeout(connect, wait);
      }
    };

    // Mark initial window done after 1s so replay-events get skipped cleanly
    const initialDoneTimer = setTimeout(() => {
      initialWindowDone.current = true;
    }, 1200);

    connect();

    const onVisibility = (): void => {
      if (!document.hidden && !esRef.current && !cancelled) {
        backoffRef.current = 1000;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearTimeout(initialDoneTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (esRef.current) {
        try {
          esRef.current.close();
        } catch {
          // ignore
        }
        esRef.current = null;
      }
    };
    // Bug-3-Fix: workspaceId is DELIBERATELY NOT in the deps. The ref
    // workspaceIdRef is updated synchronously (line above in the hook body).
    // If workspaceId were in the deps, every switch would close + reopen
    // the EventSource → a visual stream break.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, includeInitial]);
}
