'use client';

/**
 * ActiveWorkstreamBanner — Sub-Plan 01b (2026-04-29).
 *
 * Zeigt im Chat einen dezenten Banner solange im aktuellen Workspace
 * mindestens ein Workstream im Status `active` oder `paused` läuft.
 * Polling alle 30 s; Re-Fetch sobald ein iterate-version-Event vom
 * Workstream-Detail-Stream kommt (via Custom-Event-Bus).
 *
 * User-Befund 2026-04-29: nach Reload weiß User nicht ob ein Workstream
 * weiterhin arbeitet. Banner gibt visuelles Feedback + Klick-Tunnel in
 * den Workstream.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDur } from './format-duration';

interface ActiveWorkstream {
  id: string;
  name?: string | null;
  status: 'active' | 'paused' | 'done' | 'archived' | 'stuck';
  workspaceId: string;
  /** Unix-ms des letzten Updates — für Laufzeit-Anzeige. */
  updatedAt?: number | null;
}

interface BannerState {
  loading: boolean;
  active: ActiveWorkstream[];
}

const POLL_MS = 30_000;
const DUR_TICK_MS = 15_000;
const ACTIVE_WS_REFRESH_EVENT = 'lazyos.active-workstreams-refresh';

export function ActiveWorkstreamBanner({
  workspaceId,
}: {
  workspaceId: string;
}): React.JSX.Element | null {
  const [state, setState] = useState<BannerState>({
    loading: true,
    active: [],
  });
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick alle 15 s damit die Laufzeit-Anzeige im Banner fortschreitet.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), DUR_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async (): Promise<void> => {
      try {
        // Phase 01c — fetch alle live + stuck + paused parallel.
        const [activeR, stuckR] = await Promise.all([
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=active&limit=20`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
          fetch(
            `/api/workstreams?workspaceId=${encodeURIComponent(workspaceId)}&status=stuck&limit=20`,
            { cache: 'no-store' },
          ).then((r) => (r.ok ? r.json() : { workstreams: [] })),
        ]);
        if (cancelled) return;
        const all = [
          ...((activeR as { workstreams?: ActiveWorkstream[] }).workstreams ?? []),
          ...((stuckR as { workstreams?: ActiveWorkstream[] }).workstreams ?? []),
        ];
        const active = all.filter(
          (w) =>
            w.status === 'active' ||
            w.status === 'paused' ||
            w.status === 'stuck',
        );
        setState({ loading: false, active });
      } catch {
        if (!cancelled) setState({ loading: false, active: [] });
      }
    };

    void load();
    timer = setInterval(load, POLL_MS);

    const onRefresh = (): void => {
      void load();
    };
    window.addEventListener(ACTIVE_WS_REFRESH_EVENT, onRefresh);

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      window.removeEventListener(ACTIVE_WS_REFRESH_EVENT, onRefresh);
    };
  }, [workspaceId]);

  if (state.loading) return null;
  if (state.active.length === 0) return null;

  const count = state.active.length;
  const single = count === 1 ? state.active[0]! : null;
  const stuckCount = state.active.filter((w) => w.status === 'stuck').length;
  const isStuck = stuckCount > 0;
  const href = single
    ? `/workstreams/${encodeURIComponent(single.id)}`
    : `/workstreams?workspaceId=${encodeURIComponent(workspaceId)}`;

  // Laufzeit des primären / einzigen Workstreams (null → kein Suffix).
  const singleDur = single?.updatedAt ? formatDur(single.updatedAt, now) : null;

  return (
    <div className={`active-ws-banner${isStuck ? ' is-stuck' : ''}`}>
      <Link href={href} className="active-ws-banner-link">
        <span className="active-ws-banner-icon" aria-hidden="true">
          {isStuck ? (
            <svg
              viewBox="0 0 24 24"
              width="1em"
              height="1em"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          ) : (
            '◉'
          )}
        </span>
        <span className="active-ws-banner-text">
          {isStuck && count === 1 ? (
            <>
              Workstream hängt{single?.name ? ` · ${single.name}` : ''} —
              Resume?
            </>
          ) : isStuck ? (
            <>
              {stuckCount} hängt{stuckCount === 1 ? '' : 'en'} · {count - stuckCount}{' '}
              aktiv — prüfen
            </>
          ) : count === 1 ? (
            <>
              Workstream läuft{single?.name ? ` · ${single.name}` : ''}
              {singleDur ? (
                <span className="active-ws-banner-dur"> · {singleDur}</span>
              ) : null}
            </>
          ) : (
            <>{count} Workstreams aktiv</>
          )}
        </span>
        <span className="active-ws-banner-cta" aria-hidden="true">
          öffnen →
        </span>
      </Link>
    </div>
  );
}

/**
 * Public Helper: andere Components können dispatchen damit der Banner
 * sofort re-fetched (z.B. wenn ein iterate-version-Event reinkommt).
 */
export function refreshActiveWorkstreams(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ACTIVE_WS_REFRESH_EVENT));
}
