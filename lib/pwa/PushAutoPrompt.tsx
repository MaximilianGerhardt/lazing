'use client';

/**
 * PushAutoPrompt — first-open inline card.
 *
 * User request 2026-05-01: „Push-Popup muss IMMER beim ersten PWA-Öffnen
 * kommen." — re-activated after the 2026-04-29 veto. This time NOT as an overlay
 * (no `position: fixed`), but as an inline surface card that lands in the chat stream
 * as the first system message (or at the page top on
 * non-chat routes). This respects the surface-library rule and is
 * visible at the same time, because it occupies the page top line.
 *
 * Trigger conditions (all must apply):
 *   1. PWA standalone mode OR desktop (no push possible on an iOS tab)
 *   2. localStorage `lazyos.push.prompted !== '1'` (the user has not yet
 *      actively clicked "Später" or "Aktivieren" — INDEPENDENT of the date,
 *      user finding "must ALWAYS come when you open it for the first time")
 *   3. Notification.permission === 'default' (not yet decided —
 *      with 'granted' it is already active, with 'denied' a re-prompt does nothing)
 *
 * Click „Aktivieren": full subscribe pipeline via usePushSubscription.
 * Click „Später": only sets the prompted flag and hides the card.
 *
 * iOS Safari < 16.4 is already covered via usePushSubscription state='unsupported'
 * — the card then does not show.
 */

import { useCallback, useState } from 'react';

import { usePushSubscription } from './usePushSubscription';

const PROMPTED_KEY = 'lazyos.push.prompted';

interface Props {
  vapidPublicKey: string;
  /**
   * Optional: custom className for the surface container — the chat mount point
   * sets e.g. 'push-prompt-card--chat-system' so the card
   * visually reconciles with the other system messages.
   */
  className?: string;
}

/**
 * Lazy init: read the prompt lock directly in the useState initialiser, instead
 * of setting it in useEffect — avoids the `react-hooks/set-state-in-effect`
 * lint and the initial flicker frame.
 */
function readPromptLock(): boolean {
  if (typeof window === 'undefined') return true; // SSR: do not show
  try {
    return window.localStorage.getItem(PROMPTED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Doc-trigger #3: only prompt when the OS permission is NOT yet decided
 * (`default`). With `granted`, push is already allowed (re-prompt pointless —
 * a missing local subscription is the job of SubscribeButton/Resubscribe,
 * not this first-open card), with `denied` a re-prompt does nothing.
 *
 * Bug fix 2026-05-23: previously `shouldShow` depended only on `sub.state === 'idle'`.
 * But `idle` ALSO occurs with `granted`-without-active-subscription → the card
 * came back on EVERY reload even though the user had long since activated push.
 */
function permissionUndecided(): boolean {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false; // SSR / no Notification API: do not show
  }
  return Notification.permission === 'default';
}

export function PushAutoPrompt({ vapidPublicKey, className }: Props): React.JSX.Element | null {
  const sub = usePushSubscription({ vapidPublicKey });
  const [archived, setArchived] = useState<boolean>(false);
  // The lock is read only once on mount — when the user later clicks "Aktivieren",
  // we set the lock flag in the handler + setArchived(true), and the
  // card disappears without us having to read again here.
  const [locked] = useState<boolean>(readPromptLock);
  // OS permission status once on mount (same lazy-init reasoning as locked).
  const [undecided] = useState<boolean>(permissionUndecided);

  // Derive shouldShow from sub.state + locked + permission (no useEffect →
  // no set-state-in-effect issue). `undecided` enforces doc-trigger #3.
  const shouldShow = !locked && undecided && sub.state === 'idle';

  const dismissForever = useCallback(() => {
    try {
      window.localStorage.setItem(PROMPTED_KEY, '1');
    } catch {
      /* non-fatal */
    }
    setArchived(true);
  }, []);

  const onActivate = useCallback(async () => {
    await sub.subscribe();
    // Always set the lock — regardless of granted or denied. The user has
    // decided and should not be asked again on every re-open.
    try {
      window.localStorage.setItem(PROMPTED_KEY, '1');
    } catch {
      /* non-fatal */
    }
    // After success: show the card for 4 s (with a success message), then archive.
    if (sub.state === 'subscribed' || sub.state === 'working') {
      window.setTimeout(() => setArchived(true), 4000);
    }
  }, [sub]);

  if (archived || !shouldShow) return null;

  const isWorking = sub.state === 'working';
  const isSuccess = sub.state === 'subscribed';
  const isDenied = sub.state === 'denied';
  const isError = sub.state === 'error';

  return (
    <article
      className={`push-prompt-card${className ? ` ${className}` : ''}`}
      role="region"
      aria-label="Push-Benachrichtigungen aktivieren"
      data-testid="push-autoprompt"
    >
      <div className="push-prompt-card__icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      </div>
      <div className="push-prompt-card__body">
        {isSuccess ? (
          <>
            <h3 className="push-prompt-card__title">Push aktiv</h3>
            <p className="push-prompt-card__hint">
              Du bekommst Bescheid bei P0-Tickets, Approvals, fertigem Sniper
              und Workstream-Stuck.
            </p>
          </>
        ) : isDenied ? (
          <>
            <h3 className="push-prompt-card__title">Notification blockiert</h3>
            <p className="push-prompt-card__hint">
              Du hast Push abgelehnt. Reaktivieren in den Browser-Settings für
              laz.ing oder via iOS Settings → Notifications → laz.ing.
            </p>
            <div className="push-prompt-card__actions">
              <button
                type="button"
                className="push-prompt-card__btn"
                onClick={dismissForever}
              >
                Schließen
              </button>
            </div>
          </>
        ) : isError ? (
          <>
            <h3 className="push-prompt-card__title">Konnte nicht aktivieren</h3>
            <p className="push-prompt-card__hint">{sub.message || 'Unbekannter Fehler.'}</p>
            <div className="push-prompt-card__actions">
              <button
                type="button"
                className="push-prompt-card__btn push-prompt-card__btn--primary"
                onClick={onActivate}
              >
                Nochmal versuchen
              </button>
              <button
                type="button"
                className="push-prompt-card__btn"
                onClick={dismissForever}
              >
                Schließen
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="push-prompt-card__title">Push aktivieren?</h3>
            <p className="push-prompt-card__hint">
              Kein Spam — nur wenn ein Sniper fertig ist, ein Approval
              ansteht oder eine P0-Routine fehlschlägt.
            </p>
            <div className="push-prompt-card__actions">
              <button
                type="button"
                className="push-prompt-card__btn push-prompt-card__btn--primary"
                onClick={onActivate}
                disabled={isWorking}
                aria-busy={isWorking}
              >
                {isWorking ? 'Aktiviere …' : 'Aktivieren'}
              </button>
              <button
                type="button"
                className="push-prompt-card__btn"
                onClick={dismissForever}
                disabled={isWorking}
              >
                Später
              </button>
            </div>
          </>
        )}
      </div>
    </article>
  );
}

export default PushAutoPrompt;
