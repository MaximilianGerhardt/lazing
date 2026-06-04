'use client';

/**
 * SwNavigationBridge — Push-Click → direkter Nav.
 *
 * 3-Layer-Strategy gegen iOS-PWA-Standalone-Quirks:
 *
 * 1. **postMessage-Listener**: SW sendet 'lazyos:navigate-to', wir nutzen
 *    next/router router.push fuer SPA-Navigation. Funktioniert wenn PWA
 *    bereits offen war.
 *
 * 2. **Cache-API-Pending-Read** beim Mount + on visibility-change: SW
 *    schreibt target in Cache-Entry '/__lazyos_pending_nav__'. Wir lesen
 *    den, navigieren hin, clearen. Fixt iOS-PWA-Bug wo openWindow die URL
 *    ignoriert und Last-Visited-Page laedt.
 *
 * 3. **router.push fallback to window.location.href** wenn Next.js-Router
 *    throwt (z.B. SSR-Race).
 *
 * Pending-TTL: 60s — aelter ignorieren damit alte Pushes nicht naechste
 * Session unerwartet hijacken.
 */

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const PENDING_NAV_URL = '/__lazyos_pending_nav__';
const PENDING_TTL_MS = 60_000;

interface NavMessage {
  type: 'lazyos:navigate-to';
  url: string;
}

function isNavMessage(v: unknown): v is NavMessage {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.type === 'lazyos:navigate-to' && typeof m.url === 'string';
}

export function SwNavigationBridge() {
  const router = useRouter();
  const lastNavigatedRef = useRef<string | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    const navigate = (url: string): void => {
      const safeUrl = url.startsWith('/') ? url : '/';
      // Skip wenn wir gerade dort sind oder gerade dort navigiert haben
      if (window.location.pathname + window.location.search === safeUrl) return;
      if (lastNavigatedRef.current === safeUrl) return;
      lastNavigatedRef.current = safeUrl;
      try {
        router.push(safeUrl);
      } catch {
        try {
          window.location.href = safeUrl;
        } catch {
          /* noop */
        }
      }
    };

    // Layer 1: postMessage-Listener
    const handler = (ev: MessageEvent): void => {
      const data = ev.data;
      if (!isNavMessage(data)) return;
      navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', handler);

    // Layer 2: Cache-API-Pending lesen — beim Mount und bei visibility-change
    const checkPending = async (): Promise<void> => {
      try {
        if (!('caches' in window)) return;
        // Alle Caches durchgehen weil VERSION-spezifisch
        const cacheNames = await caches.keys();
        for (const name of cacheNames) {
          if (!name.includes('runtime')) continue;
          const cache = await caches.open(name);
          const resp = await cache.match(PENDING_NAV_URL);
          if (!resp) continue;
          try {
            const data = (await resp.json()) as { url?: string; ts?: number };
            const age = Date.now() - (data.ts ?? 0);
            if (age > PENDING_TTL_MS) {
              await cache.delete(PENDING_NAV_URL);
              continue;
            }
            if (typeof data.url !== 'string') {
              await cache.delete(PENDING_NAV_URL);
              continue;
            }
            // Konsumieren + navigieren
            await cache.delete(PENDING_NAV_URL);
            navigate(data.url);
            return;
          } catch {
            await cache.delete(PENDING_NAV_URL).catch(() => undefined);
          }
        }
      } catch {
        /* ignore — best effort */
      }
    };

    void checkPending();

    const onVisible = (): void => {
      if (document.hidden) return;
      void checkPending();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      navigator.serviceWorker.removeEventListener('message', handler);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}
