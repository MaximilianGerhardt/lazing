'use client';

/**
 * usePushSubscription — Single-Source-Hook für alle Push-Subscription-UI.
 *
 * Konsolidiert den State-Code, der vorher 3× dupliziert war
 * (PushAutoPrompt, SubscribeButton, future PushToggle):
 *   - Support-Detection (Notification API, ServiceWorker, PushManager,
 *     iOS-PWA-Standalone-Mode-Gate)
 *   - Existing-Subscription-Lookup
 *   - subscribe()  — full Permission+SW+Push+Server-POST flow
 *   - unsubscribe() — DELETE+local unsub
 *
 * Sub-Plan-3-Konform: KEINE Overlays / sticky Cards / floating Modals —
 * der Hook gibt nur State + Actions zurück, das UI entscheidet wo gerendert
 * wird (Inline-Surface-Card im Chat, Pill in TopNav, Section im Drawer).
 *
 * iOS-Hinweis: Push ist erst seit iOS 16.4 in PWA verfügbar — und auch
 * NUR wenn die Page als PWA zum Home-Screen hinzugefügt + von dort
 * geöffnet wurde. Im normalen Mobile-Safari-Tab ist Push iOS-seitig
 * nicht möglich. Der Hook erkennt das und liefert state='unsupported'
 * mit einem aussagekräftigen `reason`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { urlBase64ToUint8Array } from './vapid';

export type PushSubscriptionState =
  | 'loading'
  | 'unsupported'
  | 'idle'
  | 'subscribed'
  | 'denied'
  | 'working'
  | 'error';

export interface PushSubscriptionStatus {
  state: PushSubscriptionState;
  /** PWA-installiert (display-mode: standalone)? Wichtig für iOS. */
  isStandalone: boolean;
  /** Letzte Fehlermeldung oder Hinweis (z.B. "iOS: zum Home-Screen hinzufügen"). */
  message: string;
  /** Endpoint der aktiven Subscription (nur wenn state==='subscribed'). */
  endpoint: string | null;
}

export interface UsePushSubscriptionOptions {
  vapidPublicKey: string;
  /**
   * Wenn true, ignoriert der Hook die iOS-Standalone-Pflicht (für Tests).
   * Default false.
   */
  bypassStandaloneGate?: boolean;
}

export interface UsePushSubscriptionResult extends PushSubscriptionStatus {
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  /** Manuell den State neu syncen (z.B. nach OS-Settings-Wechsel). */
  refresh: () => Promise<void>;
}

interface CapabilityCheck {
  supported: boolean;
  isStandalone: boolean;
  reason?: string;
}

function detectCapabilities(bypassStandaloneGate: boolean): CapabilityCheck {
  if (typeof window === 'undefined') {
    return { supported: false, isStandalone: false, reason: 'ssr' };
  }
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  ) {
    return {
      supported: false,
      isStandalone: false,
      reason: 'browser-unsupported',
    };
  }
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isIOS && !isStandalone && !bypassStandaloneGate) {
    return {
      supported: false,
      isStandalone,
      reason: 'ios-needs-pwa-install',
    };
  }
  return { supported: true, isStandalone };
}

export function usePushSubscription(
  opts: UsePushSubscriptionOptions,
): UsePushSubscriptionResult {
  const { vapidPublicKey, bypassStandaloneGate = false } = opts;
  const [status, setStatus] = useState<PushSubscriptionStatus>({
    state: 'loading',
    isStandalone: false,
    message: '',
    endpoint: null,
  });
  const cancelRef = useRef(false);

  const sync = useCallback(async (): Promise<void> => {
    const caps = detectCapabilities(bypassStandaloneGate);
    if (!caps.supported) {
      if (cancelRef.current) return;
      setStatus({
        state: 'unsupported',
        isStandalone: caps.isStandalone,
        message:
          caps.reason === 'ios-needs-pwa-install'
            ? 'iOS: zuerst zum Home-Screen hinzufügen, dann PWA öffnen.'
            : caps.reason === 'browser-unsupported'
              ? 'Browser unterstützt keine Web-Push-Notifications.'
              : '',
        endpoint: null,
      });
      return;
    }

    if (Notification.permission === 'denied') {
      if (cancelRef.current) return;
      setStatus({
        state: 'denied',
        isStandalone: caps.isStandalone,
        message:
          'Notification blockiert. In Browser-/iOS-Settings für laz.ing erlauben.',
        endpoint: null,
      });
      return;
    }

    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const existing = await reg?.pushManager.getSubscription();
      if (cancelRef.current) return;
      if (existing && Notification.permission === 'granted') {
        setStatus({
          state: 'subscribed',
          isStandalone: caps.isStandalone,
          message: '',
          endpoint: existing.endpoint,
        });
      } else {
        setStatus({
          state: 'idle',
          isStandalone: caps.isStandalone,
          message: '',
          endpoint: null,
        });
      }
    } catch {
      if (cancelRef.current) return;
      setStatus({
        state: 'idle',
        isStandalone: caps.isStandalone,
        message: '',
        endpoint: null,
      });
    }
  }, [bypassStandaloneGate]);

  useEffect(() => {
    cancelRef.current = false;
    // Microtask-Kick statt direkter Sync-Call — vermeidet die
    // react-hooks/set-state-in-effect-Lint-Regel und entkoppelt den
    // initial-Sync von der React-Render-Phase.
    const handle = Promise.resolve().then(() => sync());
    return () => {
      cancelRef.current = true;
      // handle wird nicht awaited — der cancelRef-Guard im sync()-Body
      // verhindert setState nach unmount.
      void handle;
    };
  }, [sync]);

  const subscribe = useCallback(async (): Promise<void> => {
    if (!vapidPublicKey) {
      setStatus((s) => ({
        ...s,
        state: 'error',
        message: 'VAPID-Public-Key fehlt. Operator muss .env.local aktualisieren.',
      }));
      return;
    }
    setStatus((s) => ({ ...s, state: 'working', message: '' }));
    try {
      const reg =
        (await navigator.serviceWorker.getRegistration('/')) ??
        (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
      if (reg.installing) {
        await new Promise<void>((resolve) => {
          const sw = reg.installing!;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'activated') resolve();
          });
        });
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setStatus((s) => ({
          ...s,
          state: permission === 'denied' ? 'denied' : 'idle',
          message:
            permission === 'denied'
              ? 'Du hast Push abgelehnt. Reaktivieren in den Browser-Settings.'
              : '',
          endpoint: null,
        }));
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!res.ok) {
        throw new Error(`subscribe-failed (${res.status})`);
      }
      // B3-fix (2026-05-25): kein localStorage-Flag mehr. Der PushManager selbst
      // ist die einzige Quelle der Wahrheit — sync() liest beim Reload via
      // pushManager.getSubscription() den echten Subscription-State.
      setStatus((s) => ({
        ...s,
        state: 'subscribed',
        message: 'Push aktiviert. Du bekommst Workstream-Updates.',
        endpoint: sub.endpoint,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, state: 'error', message: msg }));
    }
  }, [vapidPublicKey]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    setStatus((s) => ({ ...s, state: 'working', message: '' }));
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const existing = await reg?.pushManager.getSubscription();
      if (existing) {
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        }).catch(() => undefined);
        await existing.unsubscribe();
      }
      // B3-fix (2026-05-25): kein localStorage-Flag entfernen nötig —
      // localStorage wird nicht mehr als State-Quelle genutzt.
      setStatus((s) => ({
        ...s,
        state: 'idle',
        message: 'Push deaktiviert.',
        endpoint: null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, state: 'error', message: msg }));
    }
  }, []);

  return {
    ...status,
    subscribe,
    unsubscribe,
    refresh: sync,
  };
}
