'use client';

/**
 * PushToggle — TopNav-Pill (analog ObservatoryIndicator).
 *
 * States:
 *   - off          → icon grayed out, click triggers the subscribe flow
 *   - on           → icon with accent, click triggers unsubscribe
 *   - denied       → icon with strike-through, click shows a tooltip hint
 *                    (iOS settings → Notifications → laz.ing)
 *   - unsupported  → hidden (no point showing it)
 *   - working      → icon with spinner pulse, no click
 *
 * Tokens-only styling. No inline hex.
 *
 * Accents analogous to ObservatoryIndicator:
 *   on → --a-clientb (green/active)
 *   off → --line-2 (neutral)
 *   denied → --a-danger (red)
 *   working → pulse animation
 */

import { useCallback } from 'react';

import { usePushSubscription } from '@/lib/pwa/usePushSubscription';

interface Props {
  vapidPublicKey: string;
}

export function PushToggle({ vapidPublicKey }: Props): React.JSX.Element | null {
  const sub = usePushSubscription({ vapidPublicKey });

  const onClick = useCallback(() => {
    if (sub.state === 'idle' || sub.state === 'error') {
      void sub.subscribe();
    } else if (sub.state === 'subscribed') {
      void sub.unsubscribe();
    } else if (sub.state === 'denied') {
      // Hint via title — the browser can't re-enable it via code.
      // We flash no modal, the tooltip has to suffice.
    }
  }, [sub]);

  // Hidden in the 'unsupported' case (no point showing the pill).
  if (sub.state === 'unsupported') return null;

  const variant = (() => {
    switch (sub.state) {
      case 'subscribed':
        return 'on';
      case 'denied':
        return 'denied';
      case 'working':
      case 'loading':
        return 'loading';
      case 'error':
        return 'error';
      default:
        return 'off';
    }
  })();

  const label = (() => {
    switch (sub.state) {
      case 'subscribed':
        return 'Push aktiv. Klicken zum Deaktivieren.';
      case 'denied':
        return 'Push blockiert. iOS: Settings → Notifications → laz.ing zulassen. Browser: Site-Settings.';
      case 'working':
        return 'Push wird umgeschaltet …';
      case 'loading':
        return 'Push-Status lädt …';
      case 'error':
        return `Push-Fehler: ${sub.message}. Klicken für Retry.`;
      case 'idle':
      default:
        return 'Push aktivieren';
    }
  })();

  const isClickable =
    sub.state === 'idle' ||
    sub.state === 'subscribed' ||
    sub.state === 'error';

  return (
    <button
      type="button"
      className={`push-toggle__pill push-toggle__pill--${variant}`}
      onClick={onClick}
      disabled={!isClickable}
      aria-label={label}
      aria-pressed={sub.state === 'subscribed'}
      title={label}
      data-testid="push-toggle"
    >
      <span className="push-toggle__icon" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          {variant === 'denied' ? <line x1="3" y1="3" x2="21" y2="21" /> : null}
        </svg>
      </span>
    </button>
  );
}

export default PushToggle;
