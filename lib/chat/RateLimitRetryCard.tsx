'use client';

/**
 * RateLimitRetryCard — Phase RL.2 (2026-04-28)
 *
 * Appears when the last stream broke off due to an Anthropic TPM throttle.
 * Shows a 30s countdown and automatically resends the last user question.
 * The user can cancel with "Stop" or try again immediately
 * with "Jetzt erneut".
 *
 * Max 2 auto-retries per original prompt — after that only manual remains.
 *
 * Wave 4.1 (2026-05-01): inline styles → CSS classes `.srf-rl__*` (token bind).
 */

import { useEffect, useRef, useState } from 'react';

interface Props {
  attempt: number; // 1-based: 1, 2 (max 2)
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
