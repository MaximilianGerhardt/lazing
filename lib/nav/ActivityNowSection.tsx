'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * ActivityNowSection — "Aktiv jetzt" Drawer-Section.
 *
 * Sub-Plan 4: zeigt die laufenden Items aus /api/activity/live als
 * kompakte Liste. Nur sichtbar wenn der Drawer offen ist (parent-
 * controlled durch MobileDrawer). Kein eigener Polling-Loop —
 * lädt einmal beim Mount + refresht beim Custom-Event
 * 'lazyos:activity:refresh'. Schont Bandbreite.
 *
 * Kein Overlay, keine Sticky-Card. Standard-List-UI mit Pills.
 */

interface ActivityItem {
  type: 'workstream' | 'workflow' | 'routine' | 'sub-workstream';
  id: string;
  label: string;
  phase: string | null;
  lastTickMs: number | null;
  workspaceId: string;
}

interface ActivityResponse {
  ok?: boolean;
  running?: number;
  paused?: number;
  stuck?: number;
  cronSoon?: number;
  items?: ActivityItem[];
}

const LIST_LIMIT = 10;

interface Props {
  onNavigate: () => void;
}

export function ActivityNowSection({
  onNavigate,
}: Props): React.JSX.Element | null {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [totalCounts, setTotalCounts] = useState<{
    running: number;
    paused: number;
    stuck: number;
    cronSoon: number;
  }>({ running: 0, paused: 0, stuck: 0, cronSoon: 0 });
  const [loaded, setLoaded] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = (): void => {
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      void fetch('/api/activity/live', {
        cache: 'no-store',
        signal: ctrl.signal,
      })
        .then((r) => (r.ok ? (r.json() as Promise<ActivityResponse>) : null))
        .then((body) => {
          if (cancelled || !body || body.ok === false) {
            setLoaded(true);
            return;
          }
          setItems(body.items ?? []);
          setTotalCounts({
            running: body.running ?? 0,
            paused: body.paused ?? 0,
            stuck: body.stuck ?? 0,
            cronSoon: body.cronSoon ?? 0,
          });
          setLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setLoaded(true);
        });
    };

    load();
    const onRefresh = (): void => load();
    window.addEventListener('lazyos:activity:refresh', onRefresh);
    return () => {
      cancelled = true;
      inflight.current?.abort();
      window.removeEventListener('lazyos:activity:refresh', onRefresh);
    };
  }, []);

  const total =
    totalCounts.running +
    totalCounts.paused +
    totalCounts.stuck +
    totalCounts.cronSoon;

  if (!loaded) {
    return (
      <section
        className="topnav-drawer-section"
        aria-label="Aktiv jetzt"
        id="drawer-section-activity"
      >
        <h2 className="topnav-drawer-heading">Aktiv jetzt</h2>
        <p className="topnav-drawer-empty" role="note">
          Lade …
        </p>
      </section>
    );
  }

  // Wenn nichts läuft: kompakte Empty-State-Zeile, nicht ganz unsichtbar
  // (User will den Status sehen, nicht raten).
  if (total === 0) {
    return (
      <section
        className="topnav-drawer-section"
        aria-label="Aktiv jetzt"
        id="drawer-section-activity"
      >
        <h2 className="topnav-drawer-heading">Aktiv jetzt</h2>
        <p className="topnav-drawer-empty" role="note">
          Nichts läuft im Hintergrund.
        </p>
      </section>
    );
  }

  const visible = items.slice(0, LIST_LIMIT);
  const overflow = Math.max(0, total - LIST_LIMIT);

  return (
    <section
      className="topnav-drawer-section"
      aria-label="Aktiv jetzt"
      id="drawer-section-activity"
    >
      <div className="topnav-drawer-ws-head">
        <h2 className="topnav-drawer-heading">Aktiv jetzt</h2>
        <span
          className="topnav-drawer-ws-current"
          aria-label={`${total} Hintergrund-Items`}
        >
          {total}
        </span>
      </div>
      <ul className="topnav-drawer-list" role="list">
        {visible.map((it) => (
          <li key={`${it.type}-${it.id}`}>
            <Link
              href={hrefFor(it)}
              className="topnav-drawer-link"
              onClick={onNavigate}
            >
              <span className="topnav-drawer-ico" aria-hidden="true">
                {iconFor(it.type)}
              </span>
              <span className="topnav-drawer-link-label">
                {it.label}
                {it.phase ? (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 12,
                      opacity: 0.6,
                    }}
                  >
                    {it.phase}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {overflow > 0 ? (
        <Link
          href="/lanes"
          className="topnav-drawer-link"
          onClick={onNavigate}
          style={{ fontSize: 13, opacity: 0.7 }}
        >
          +{overflow} weitere in /lanes
        </Link>
      ) : null}
    </section>
  );
}

function hrefFor(it: ActivityItem): string {
  switch (it.type) {
    case 'workstream':
    case 'sub-workstream':
      return `/workstreams/${encodeURIComponent(it.id)}`;
    case 'workflow':
      return `/workflows/${encodeURIComponent(it.id)}`;
    case 'routine':
      return `/routines/${encodeURIComponent(it.id)}`;
    default:
      return '/lanes';
  }
}

function iconFor(type: ActivityItem['type']): string {
  switch (type) {
    case 'workstream':
      return '◉';
    case 'sub-workstream':
      return '◎';
    case 'workflow':
      return '⤳';
    case 'routine':
      return '↻';
    default:
      return '·';
  }
}

export default ActivityNowSection;
