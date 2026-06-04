'use client';

/**
 * usePushSubscription — single-source hook for all push-subscription UI.
 *
 * Consolidates the state code that was previously duplicated 3×
 * (PushAutoPrompt, SubscribeButton, future PushToggle):
 *   - support detection (Notification API, ServiceWorker, PushManager,
 *     iOS PWA standalone-mode gate)
 *   - existing-subscription lookup
 *   - subscribe()  — full permission+SW+push+server-POST flow
 *   - unsubscribe() — DELETE+local unsub
 *
 * Sub-Plan-3-compliant: NO overlays / sticky cards / floating modals —
 * the hook returns only state + actions, the UI decides where it is rendered
 * (inline surface card in chat, pill in TopNav, section in the drawer).
 *
 * iOS note: push has been available in PWA only since iOS 16.4 — and also
 * ONLY when the page was added to the home screen as a PWA + opened from
 * there. In a normal mobile-Safari tab, push is not possible on iOS.
 * The hook detects this and returns state='unsupported'
 * with a meaningful `reason`.
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
  /** PWA-installed (display-mode: standalone)? Important for iOS. */
  isStandalone: boolean;
  /** Last error message or hint (e.g. "iOS: add to the home screen"). */
  message: string;
  /** Endpoint of the active subscription (only when state==='subscribed'). */
  endpoint: string | null;
}

export interface UsePushSubscriptionOptions {
  vapidPublicKey: string;
  /**
   * If true, the hook ignores the iOS standalone requirement (for tests).
   * Default false.
   */
  bypassStandaloneGate?: boolean;
}

export interface UsePushSubscriptionResult extends PushSubscriptionStatus {
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  /** Manually re-sync the state (e.g. after an OS-settings change). */
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
    // Microtask kick instead of a direct sync call — avoids the
    // react-hooks/set-state-in-effect lint rule and decouples the
    // initial sync from the React render phase.
    const handle = Promise.resolve().then(() => sync());
    return () => {
      cancelRef.current = true;
      // handle is not awaited — the cancelRef guard in the sync() body
      // prevents setState after unmount.
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
      // B3-fix (2026-05-25): no more localStorage flag. The PushManager itself
      // is the single source of truth — sync() reads the real subscription
      // state on reload via pushManager.getSubscription().
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
      // B3-fix (2026-05-25): no need to remove a localStorage flag —
      // localStorage is no longer used as a state source.
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
