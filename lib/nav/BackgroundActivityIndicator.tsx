'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * BackgroundActivityIndicator — Pulse-Pill für laufende Hintergrund-Arbeit.
 *
 * Sub-Plan 4 (TopNav-Pulse-Pill) — analog ObservatoryIndicator, aber
 * fokussiert auf "läuft gerade":
 *
 *   - Polling alle 30s (kürzer als Observatory-Heartbeat 60s, weil
 *     Activity sich schneller ändert)
 *   - AbortController + visibilitychange-Pause
 *   - Apple-Pure: --press-scale, --spring-bouncy, Tokens-only
 *   - Pill grau bei count=0 (kein Spam), --a-now bei >0
 *   - Click → öffnet MobileDrawer (Custom-Event 'lazyos:drawer:open' mit
 *     anchor=#activity), keine Overlays
 *
 * KEIN Sticky, KEINE Floating-Card, KEIN Modal. Nur Pill in TopNav.
 *
 * Counts:
 *   - running    → primärer Anzeigewert
 *   - paused     → wenn >0 als " · Np" Suffix
 *   - stuck      → wenn >0 als " · Ns stuck"
 *   - cronSoon   → wenn >0 als " · Nc soon"
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
 * Welle 1 · 2026-05-03: optional excludeWorkstreamId, wird vom ChatShell
 * via Custom-Event broadcasted. Verhindert dass der gerade laufende
 * eigene Stream doppelt im Pulse-Pill mitgezaehlt wird.
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
  // Welle 1 · 2026-05-03: aktiver Workstream im ChatShell, der NICHT
  // mitzaehlen soll. Wird via 'lazyos:active-workstream-changed' gesetzt.
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
      // Refetch sofort, damit die UI nicht 30s auf den naechsten Tick wartet.
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
    // Drawer öffnen + zur Activity-Section scrollen. Kein Overlay,
    // nutzt existierende MobileDrawer-Section #activity.
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

  // Compact-Text: leer ("—") wenn nichts läuft, sonst kompakte Form.
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
  if (totalActive === 0) variant = 'loading'; // grau bei 0 (kein Spam)

  const ariaParts = [`${running} laufend`];
  if (paused > 0) ariaParts.push(`${paused} pausiert`);
  if (stuck > 0) ariaParts.push(`${stuck} blockiert`);
  if (cronSoon > 0) ariaParts.push(`${cronSoon} Cron in 15min`);
  const aria = `Hintergrund: ${ariaParts.join(', ')}. Klicken für Details.`;

  return { text, aria, variant, totalActive };
}

export default BackgroundActivityIndicator;
