'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * BackgroundActivityIndicator — pulse pill for running background work.
 *
 * Sub-plan 4 (TopNav pulse pill) — analogous to ObservatoryIndicator, but
 * focused on "currently running":
 *
 *   - polling every 30s (shorter than the Observatory heartbeat 60s, because
 *     activity changes faster)
 *   - AbortController + visibilitychange pause
 *   - Apple-pure: --press-scale, --spring-bouncy, tokens only
 *   - pill grey at count=0 (no spam), --a-now at >0
 *   - click → opens MobileDrawer (custom event 'lazyos:drawer:open' with
 *     anchor=#activity), no overlays
 *
 * NO sticky, NO floating card, NO modal. Only a pill in TopNav.
 *
 * Counts:
 *   - running    → primary displayed value
 *   - paused     → when >0 as a " · Np" suffix
 *   - stuck      → when >0 as " · Ns stuck"
 *   - cronSoon   → when >0 as " · Nc soon"
 */

interface ActivityResponse {
  ok?: boolean;
  running?: number;
  paused?: number;
  stuck?: number;
  cronSoon?: number;
}

type IndicatorState =
  | { kind: 'loading' }
  | {
      kind: 'ok';
      running: number;
      paused: number;
      stuck: number;
      cronSoon: number;
    }
  | { kind: 'down' };

const POLL_INTERVAL_MS = 30_000;

/**
 * Wave 1 · 2026-05-03: optional excludeWorkstreamId, broadcast by the ChatShell
 * via a custom event. Prevents the currently running
 * own stream from being double-counted in the pulse pill.
 */
async function fetchActivity(
  signal: AbortSignal,
  excludeWorkstreamId: string | null,
): Promise<IndicatorState> {
  try {
    const url = excludeWorkstreamId
      ? `/api/activity/live?excludeWorkstream=${encodeURIComponent(excludeWorkstreamId)}`
      : '/api/activity/live';
    const res = await fetch(url, {
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return { kind: 'down' };
    const body = (await res.json()) as ActivityResponse;
    if (body.ok === false) return { kind: 'down' };
    return {
      kind: 'ok',
      running: body.running ?? 0,
      paused: body.paused ?? 0,
      stuck: body.stuck ?? 0,
      cronSoon: body.cronSoon ?? 0,
    };
  } catch {
    return { kind: 'down' };
  }
}

export function BackgroundActivityIndicator(): React.JSX.Element {
  const [state, setState] = useState<IndicatorState>({ kind: 'loading' });
  const timerRef = useRef<number | null>(null);
  const inflightRef = useRef<AbortController | null>(null);
  // Wave 1 · 2026-05-03: active workstream in the ChatShell that should NOT
  // be counted. Set via 'lazyos:active-workstream-changed'.
  const activeWorkstreamRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const tick = (): void => {
      inflightRef.current?.abort();
      const ctrl = new AbortController();
      inflightRef.current = ctrl;
      void fetchActivity(ctrl.signal, activeWorkstreamRef.current).then(
        (next) => {
          if (cancelled) return;
          setState(next);
        },
      );
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

    const onActiveWorkstreamChanged = (e: Event): void => {
      const detail = (e as CustomEvent).detail as
        | { workstreamId?: string | null }
        | undefined;
      const next = detail?.workstreamId ?? null;
      if (next === activeWorkstreamRef.current) return;
      activeWorkstreamRef.current = next;
      // Refetch immediately so the UI does not wait 30s for the next tick.
      tick();
    };

    tick();
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener(
      'lazyos:active-workstream-changed',
      onActiveWorkstreamChanged as EventListener,
    );

    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener(
        'lazyos:active-workstream-changed',
        onActiveWorkstreamChanged as EventListener,
      );
      inflightRef.current?.abort();
    };
  }, []);

  const { text, aria, variant, totalActive } = describe(state);

  const handleClick = (): void => {
    // Open the drawer + scroll to the activity section. No overlay,
    // uses the existing MobileDrawer section #activity.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('lazyos:drawer:open', {
          detail: { anchor: 'activity' },
        }),
      );
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`topnav-obs topnav-obs--${variant} topnav-activity-pill`}
      aria-label={aria}
      title={aria}
      data-count={totalActive}
    >
      <span className="topnav-obs-dot" aria-hidden="true" />
      <span className="topnav-obs-text" aria-hidden="true">
        {text}
      </span>
    </button>
  );
}

function describe(state: IndicatorState): {
  text: string;
  aria: string;
  variant: 'live' | 'warn' | 'down' | 'loading';
  totalActive: number;
} {
  if (state.kind === 'loading') {
    return {
      text: '—',
      aria: 'Hintergrund-Aktivität: lädt …',
      variant: 'loading',
      totalActive: 0,
    };
  }
  if (state.kind === 'down') {
    return {
      text: '—',
      aria: 'Hintergrund-Aktivität: nicht erreichbar.',
      variant: 'down',
      totalActive: 0,
    };
  }
  const { running, paused, stuck, cronSoon } = state;
  const totalActive = running + paused + stuck + cronSoon;

  // Compact text: empty ("—") when nothing is running, otherwise a compact form.
  let text: string;
  if (totalActive === 0) {
    text = '0';
  } else {
    const parts: string[] = [String(running)];
    if (paused > 0) parts.push(`${paused}p`);
    // Severity is also conveyed by the pill variant colour (live/warn).
    if (stuck > 0) parts.push(`${stuck} stuck`);
    if (cronSoon > 0) parts.push(`${cronSoon} soon`);
    text = parts.join(' · ');
  }

  let variant: 'live' | 'warn' | 'down' | 'loading' = 'live';
  if (stuck > 0) variant = 'warn';
  if (totalActive === 0) variant = 'loading'; // grey at 0 (no spam)

  const ariaParts = [`${running} laufend`];
  if (paused > 0) ariaParts.push(`${paused} pausiert`);
  if (stuck > 0) ariaParts.push(`${stuck} blockiert`);
  if (cronSoon > 0) ariaParts.push(`${cronSoon} Cron in 15min`);
  const aria = `Hintergrund: ${ariaParts.join(', ')}. Klicken für Details.`;

  return { text, aria, variant, totalActive };
}

export default BackgroundActivityIndicator;
