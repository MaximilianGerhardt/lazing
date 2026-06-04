'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

/**
 * ObservatoryIndicator — persistent heartbeat pulse in the header.
 *
 * Fetches `/api/heartbeat/status` on mount + polls every 60s. Renders a
 * compact pill in the right cluster:
 *
 *   [●] 9            — all alive
 *   [●] 9 · 1 stale  — some stale / dormant
 *   [○] —            — bridge unreachable
 *
 * Clicking navigates to `/observatory` for the full grid. Polling pauses
 * while the tab is hidden (visibilitychange) so we don't hammer the VPS
 * while the user is elsewhere.
 *
 * Tokens-only, no hex. Error/stale colour inherits from
 * `--a-danger` / `--ink-3` in `app/globals.css`.
 */

interface HeartbeatStatus {
  ok?: boolean;
  globals?: {
    alive: number;
    stale: number;
    dormant: number;
    error: number;
    total: number;
  };
}

type IndicatorState =
  | { kind: 'loading' }
  | { kind: 'ok'; alive: number; warn: number; error: number; total: number }
  | { kind: 'down' };

const POLL_INTERVAL_MS = 60_000;

async function fetchStatus(signal: AbortSignal): Promise<IndicatorState> {
  try {
    const res = await fetch('/api/heartbeat/status', {
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return { kind: 'down' };
    const body = (await res.json()) as HeartbeatStatus;
    const g = body.globals;
    if (!g) return { kind: 'down' };
    const warn = (g.stale ?? 0) + (g.dormant ?? 0);
    return {
      kind: 'ok',
      alive: g.alive ?? 0,
      warn,
      error: g.error ?? 0,
      total: g.total ?? 0,
    };
  } catch {
    return { kind: 'down' };
  }
}

export function ObservatoryIndicator(): React.JSX.Element {
  const [state, setState] = useState<IndicatorState>({ kind: 'loading' });
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = (): void => {
      // Don't stack requests — abort the previous in-flight call.
      inflightRef.current?.abort();
      const ctrl = new AbortController();
      inflightRef.current = ctrl;
      void fetchStatus(ctrl.signal).then((next) => {
        if (cancelled) return;
        setState(next);
      });
    };

    const schedule = (): void => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => {
        if (document.visibilityState === 'visible') tick();
      }, POLL_INTERVAL_MS);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick();
    };

    tick();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      inflightRef.current?.abort();
    };
  }, []);

  const label = describe(state);
  const variant = variantFor(state);

  return (
    <Link
      href="/observatory"
      className={`topnav-obs topnav-obs--${variant}`}
      aria-label={label.aria}
      title={label.aria}
      prefetch={false}
    >
      <span className="topnav-obs-dot" aria-hidden="true" />
      <span className="topnav-obs-text" aria-hidden="true">
        {label.text}
      </span>
    </Link>
  );
}

function variantFor(state: IndicatorState): 'live' | 'warn' | 'down' | 'loading' {
  if (state.kind === 'loading') return 'loading';
  if (state.kind === 'down') return 'down';
  if (state.error > 0) return 'down';
  if (state.warn > 0) return 'warn';
  return 'live';
}

function describe(state: IndicatorState): { text: string; aria: string } {
  if (state.kind === 'loading') {
    return {
      text: '—',
      aria: 'Observatory: lädt …',
    };
  }
  if (state.kind === 'down') {
    return {
      text: '—',
      aria: 'Observatory: Bridge nicht erreichbar. Klicken für Details.',
    };
  }
  const { alive, warn, error, total } = state;
  // Compact: "9" when clean, "9 · 1 stale" when stale/dormant, "9 · 2 err" when error.
  // Severity is also conveyed by the pill variant colour (live/warn/down).
  let text = String(alive);
  if (error > 0) text = `${alive} · ${error} err`;
  else if (warn > 0) text = `${alive} · ${warn} stale`;
  const aria = `Observatory: ${alive} von ${total} alive${
    warn ? `, ${warn} stale` : ''
  }${error ? `, ${error} error` : ''}. Klicken für Details.`;
  return { text, aria };
}

export default ObservatoryIndicator;
