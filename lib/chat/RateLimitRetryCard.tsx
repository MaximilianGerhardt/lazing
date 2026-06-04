'use client';

/**
 * RateLimitRetryCard — Phase RL.2 (2026-04-28)
 *
 * Erscheint wenn der letzte Stream mit Anthropic-TPM-Throttle abriss.
 * Zeigt 30s-Countdown und schickt die letzte User-Frage automatisch
 * erneut ab. User kann mit "Stop" abbrechen oder "Jetzt erneut" sofort
 * versuchen.
 *
 * Max 2 Auto-Retries pro originalem Prompt — danach bleibt nur manuell.
 *
 * Welle 4.1 (2026-05-01): Inline-Styles → CSS-Klassen `.srf-rl__*` (Token-bind).
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  attempt: number; // 1-basiert: 1, 2 (max 2)
  maxAttempts: number;
  onRetry: () => void;
  onCancel: () => void;
}

const COUNTDOWN_SECONDS = 30;

export function RateLimitRetryCard({
  attempt,
  maxAttempts,
  onRetry,
  onCancel,
}: Props) {
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS);
  const [stopped, setStopped] = useState(false);
  const [retried, setRetried] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (stopped || retried) return;
    if (secondsLeft <= 0) return;
    const t = window.setTimeout(() => {
      if (!cancelledRef.current) setSecondsLeft((s) => s - 1);
    }, 1000);
    return () => window.clearTimeout(t);
  }, [secondsLeft, stopped, retried]);

  useEffect(() => {
    if (stopped || retried) return;
    if (secondsLeft > 0) return;
    setRetried(true);
    onRetry();
  }, [secondsLeft, stopped, retried, onRetry]);

  if (retried) {
    return (
      <div className="srf-rl">
        <div className="srf-rl__header">
          <span aria-hidden className="srf-rl__dot srf-rl__dot--now" />
          <span className="srf-rl__title">Erneuter Versuch läuft</span>
        </div>
        <div className="srf-rl__body">
          Versuch {attempt}/{maxAttempts} ist gestartet — Antwort sollte gleich
          kommen.
        </div>
      </div>
    );
  }

  if (stopped) {
    return (
      <div className="srf-rl">
        <div className="srf-rl__header">
          <span aria-hidden className="srf-rl__dot srf-rl__dot--mute" />
          <span className="srf-rl__title">Auto-Retry gestoppt</span>
        </div>
        <div className="srf-rl__body">
          Tippe deine Frage nochmal in den Chat wenn du bereit bist.
        </div>
      </div>
    );
  }

  return (
    <div className="srf-rl">
      <div className="srf-rl__header">
        <span aria-hidden className="srf-rl__dot srf-rl__dot--warn" />
        <span className="srf-rl__title">Anthropic drosselt kurz</span>
        <span className="srf-rl__pill">
          Auto-Retry {attempt}/{maxAttempts} in {secondsLeft}s
        </span>
      </div>
      <div className="srf-rl__body">
        Server-side TPM-Limit (nicht dein MAX-Plan). Ich versuche es in{' '}
        {secondsLeft}s automatisch nochmal mit der letzten Frage.
      </div>
      <div className="srf-rl__btnrow">
        <button
          type="button"
          onClick={() => setStopped(true)}
          className="srf-rl__btn srf-rl__btn--ghost"
        >
          Stop
        </button>
        <button
          type="button"
          onClick={() => {
            setRetried(true);
            onRetry();
          }}
          className="srf-rl__btn srf-rl__btn--primary"
        >
          Jetzt erneut
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="srf-rl__btn srf-rl__btn--ghost"
        >
          Verwerfen
        </button>
      </div>
    </div>
  );
}
