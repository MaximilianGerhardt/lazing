'use client';

/**
 * PushAutoPrompt — Erst-Open-Inline-Card.
 *
 * User-Wunsch 2026-05-01: „Push-Popup muss IMMER beim ersten PWA-Öffnen
 * kommen." — Re-Aktivierung nach 2026-04-29-Veto. Diesmal NICHT als Overlay
 * (no `position: fixed`), sondern als Inline-Surface-Card die im Chat-Stream
 * als erste System-Message landet (oder oben am Page-Top auf
 * Non-Chat-Routes). Das respektiert die Surface-Library-Regel und ist
 * gleichzeitig sichtbar, weil sie die Page-Topline einnimmt.
 *
 * Trigger-Bedingungen (alle müssen zutreffen):
 *   1. PWA-Standalone-Mode ODER Desktop (auf iOS-Tab kein Push möglich)
 *   2. localStorage `lazyos.push.prompted !== '1'` (User hat noch nicht
 *      aktiv "Später" oder "Aktivieren" geklickt — UNABHÄNGIG vom Datum,
 *      User-Befund "muss IMMER kommen wenn man das erste Mal öffnet")
 *   3. Notification.permission === 'default' (noch nicht entschieden —
 *      bei 'granted' ist's schon aktiv, bei 'denied' bringt Re-Prompt nichts)
 *
 * Click „Aktivieren": komplette Subscribe-Pipeline via usePushSubscription.
 * Click „Später": setzt nur das Prompted-Flag und blendet die Card.
 *
 * iOS Safari < 16.4 ist via usePushSubscription state='unsupported' bereits
 * gecovert — die Card zeigt sich dann nicht.
 */

import { useCallback, useState } from 'react';

import { usePushSubscription } from './usePushSubscription';

const PROMPTED_KEY = 'lazyos.push.prompted';

interface Props {
  vapidPublicKey: string;
  /**
   * Optional: Custom-ClassName für Surface-Container — Chat-Mount-Point
   * setzt z.B. 'push-prompt-card--chat-system' damit die Card sich
   * visuell mit den anderen System-Messages versöhnt.
   */
  className?: string;
}

/**
 * Lazy-Init: Lese den Prompt-Lock direkt im useState-Initialiser, statt
 * im useEffect zu setzten — vermeidet `react-hooks/set-state-in-effect`
 * Lint und die initiale Flicker-Frame.
 */
function readPromptLock(): boolean {
  if (typeof window === 'undefined') return true; // SSR: nicht zeigen
  try {
    return window.localStorage.getItem(PROMPTED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Doc-Trigger #3: nur prompten, wenn die OS-Permission noch NICHT entschieden
 * ist (`default`). Bei `granted` ist Push schon erlaubt (Re-Prompt sinnlos —
 * eine fehlende lokale Subscription ist Sache von SubscribeButton/Resubscribe,
 * nicht dieser Erst-Open-Card), bei `denied` bringt ein Re-Prompt nichts.
 *
 * Bug-Fix 2026-05-23: vorher hing `shouldShow` nur an `sub.state === 'idle'`.
 * `idle` tritt aber AUCH bei `granted`-ohne-aktive-Subscription ein → die Card
 * kam bei JEDEM Reload wieder, obwohl der User Push längst aktiviert hatte.
 */
function permissionUndecided(): boolean {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false; // SSR / kein Notification-API: nicht zeigen
  }
  return Notification.permission === 'default';
}

export function PushAutoPrompt({ vapidPublicKey, className }: Props): React.JSX.Element | null {
  const sub = usePushSubscription({ vapidPublicKey });
  const [archived, setArchived] = useState<boolean>(false);
  // Lock wird nur 1× beim Mount gelesen — wenn der User später "Aktivieren"
  // klickt, setzen wir das Lock-Flag im handler + setArchived(true), die
  // Card verschwindet ohne dass wir hier nochmal lesen müssen.
  const [locked] = useState<boolean>(readPromptLock);
  // OS-Permission-Status 1× beim Mount (gleiche Lazy-Init-Begründung wie locked).
  const [undecided] = useState<boolean>(permissionUndecided);

  // shouldShow ableiten aus sub.state + locked + permission (kein useEffect →
  // kein set-state-in-effect-Issue). `undecided` erzwingt Doc-Trigger #3.
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
    // Lock immer setzen — egal ob granted oder denied. User hat
    // entschieden, soll bei jedem Re-Open nicht wieder gefragt werden.
    try {
      window.localStorage.setItem(PROMPTED_KEY, '1');
    } catch {
      /* non-fatal */
    }
    // Nach success: Card 4 s zeigen (mit Erfolgsmeldung), dann archivieren.
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
