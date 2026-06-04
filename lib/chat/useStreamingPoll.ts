'use client';

/**
 * lib/chat/useStreamingPoll.ts
 * ----------------------------
 * Phase Reload-Recovery V2 · 2026-04-27.
 *
 * Pollt `/api/chat/history/[workspaceId]` alle 2000 ms solange mindestens
 * ein HistoryItem mit `streamState='streaming'` existiert. Stoppt sobald
 * keiner mehr da ist (alle final = 'completed' / 'aborted' / Snapshot
 * verschwunden = completed-Event ist da).
 *
 * Strategy (siehe /tmp/recovery-syn.txt Punkt 5):
 *   - Kein neuer Endpoint — wir reuse `loadHistoryServerFirst`.
 *   - Echo-Filter: pendingPromptId-Vergleich gegen `ownPendingIdsRef` —
 *     wenn ein gerade-live-streamender lokaler Stream existiert, schluckt
 *     der Caller das Polling-Update damit der Live-SSE Vorrang hat.
 *   - Cleanup: clearInterval bei unmount + sobald state-Final.
 *
 * Wichtig: Polling triggered nur wenn `enabled === true`. Caller deaktiviert
 * es z.B. wenn die Tab `document.visibilityState === 'hidden'` ist (Server
 * laeuft eh weiter, kein Bedarf).
 */

import { useEffect, useRef } from 'react';

import type { HistoryItem } from './ChatShell';
import { loadHistoryServerFirst, mergeServerWithLocal, type ServerSystemItem } from './storage';

const POLL_INTERVAL_MS = 2000;

interface UseStreamingPollOpts {
  /** Aktueller Workspace — bei Switch wird Polling gestoppt + neu gestartet. */
  workspaceId: string;
  /** Aktueller History-State des Callers. */
  history: HistoryItem[];
  /** Polling soll laufen? (false = Tab hidden, hydrating, ...). */
  enabled: boolean;
  /**
   * Callback bei jedem successful poll. Caller erhaelt das frische Server-
   * Item-Array; mergeServerWithLocal-Arbeit hat dieser Hook schon erledigt.
   * Caller setzt damit seinen `setHistory`-State und persistiert ggf.
   */
  onUpdate: (mergedItems: HistoryItem[], systemItems: ServerSystemItem[]) => void;
  /**
   * Optionaler Echo-Filter: wenn dieser Set die pendingPromptId eines
   * Server-Items enthaelt, gilt das Item als "lokaler Live-Stream" — der
   * Caller hat die Bubble bereits selbst im State, wir schmeissen das
   * snapshot-Item raus damit wir keinen doppelten Render erzeugen.
   *
   * Achtung: Set ist eine Ref-Mutable im Caller; wir lesen sie auf jedem
   * Tick neu (kein deps-Array-Eintrag).
   */
  ownPendingIdsRef?: { current: Set<string> };
}

/**
 * Hook fuer das 2s-Polling waehrend ein Streaming-Snapshot aktiv ist.
 *
 * - Triggert NUR wenn mindestens ein History-Item `streamState === 'streaming'`
 *   hat. Sobald alle final sind, wird der Interval cleared.
 * - Polling-Tick laedt die volle History (gleicher Endpoint wie Mount-Refresh)
 *   und merged sie mit der lokalen via `mergeServerWithLocal`.
 * - Bei Workspace-Switch: alle alten Polls werden via AbortController gekillt.
 */
export function useStreamingPoll({
  workspaceId,
  history,
  enabled,
  onUpdate,
  ownPendingIdsRef,
}: UseStreamingPollOpts): void {
  // Stable refs damit der Effect nicht bei jedem render neu mountet.
  const historyRef = useRef(history);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  // Ist im aktuellen History-Array irgendwo ein streamState='streaming'?
  // Wir koennen das nicht naiv pro Render checken (deps loop) — wir leiten
  // einen primitiv-Token ab der den Effect re-trigger.
  const streamingToken = computeStreamingToken(history);

  useEffect(() => {
    if (!enabled) return;
    if (!streamingToken) return;

    let cancelled = false;
    let intervalId: number | null = null;
    let inFlight: AbortController | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      // Re-check — wenn der Caller in der Zwischenzeit alle streaming-
      // States beendet hat (z.B. eigener Live-Stream wurde fertig),
      // muessen wir hier raus.
      const cur = historyRef.current;
      const stillStreaming = cur.some((it) => it.streamState === 'streaming');
      if (!stillStreaming) {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
        return;
      }

      inFlight?.abort();
      const ctl = new AbortController();
      inFlight = ctl;
      try {
        const res = await loadHistoryServerFirst(workspaceId, {
          limit: 60,
          signal: ctl.signal,
        });
        if (cancelled) return;

        // Echo-Filter: Server-Items die zu einem aktiven lokalen
        // Live-Stream gehoeren (pendingPromptId in ownPendingIdsRef)
        // werden ausgefiltert — der Caller rendert die Bubble eh
        // selber via useAgentStream, doppelter Render waere haesslich.
        const ownIds = ownPendingIdsRef?.current;
        const filteredServer = ownIds
          ? res.items.filter((it) => {
              if (!it.pendingPromptId) return true;
              if (!ownIds.has(it.pendingPromptId)) return true;
              // Eigener Live-Stream: nur server-Items mit streamState
              // schlucken (User-Bubble + completed-Bubble bleiben drin).
              return it.streamState === undefined;
            })
          : res.items;

        const local = historyRef.current;
        const merged = mergeServerWithLocal(filteredServer, local, res.cutoffMs);
        onUpdateRef.current(merged, res.systemItems);
      } catch {
        /* offline / 401 — naechster Tick versucht's nochmal */
      } finally {
        if (inFlight === ctl) inFlight = null;
      }
    };

    // Sofort einen Tick — der User soll nicht 2s auf den ersten Refresh warten.
    void tick();
    intervalId = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      inFlight?.abort();
    };
    // streamingToken triggert re-mount sobald sich die Set der streamenden
    // Items aendert (ein neues kommt rein, oder eines ist fertig).
    // ownPendingIdsRef bewusst NICHT in deps — Ref-Mutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, enabled, streamingToken]);
}

/**
 * Bildet einen primitiven Token aus den aktuell streamenden Items, damit
 * der Effect re-mounten/abbrechen kann sobald sich die Streaming-Population
 * aendert. Token-Format: `id1|id2|id3` (sortiert).
 */
function computeStreamingToken(items: HistoryItem[]): string {
  const ids = items
    .filter((it) => it.streamState === 'streaming')
    .map((it) => it.id)
    .sort();
  return ids.join('|');
}
