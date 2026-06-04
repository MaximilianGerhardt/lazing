'use client';

/**
 * StuckActions — Sub-Plan 01c (2026-04-29).
 *
 * Rendered at the top of the workstream detail when the workstream is
 * status='stuck' (= got stuck after a service restart). Offers:
 *
 *   - „Resume von V_{n+1}"  → POST /api/workstreams/[id]/resume
 *   - „Cancel + done"       → POST /api/workstreams/[id]/cancel
 *
 * Polls /api/workstreams/[id]/pause-status for live status.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  workstreamId: string;
  initialStatus: string;
}

export function StuckActions({ workstreamId, initialStatus }: Props): React.JSX.Element | null {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState<'resume' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  if (status !== 'stuck') {
    return null;
  }

  const onResume = async (): Promise<void> => {
    if (busy) return;
    setBusy('resume');
    setError(null);
    setLastResult(null);
    try {
      const res = await fetch(
        `/api/workstreams/${encodeURIComponent(workstreamId)}/resume`,
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        producedVersion?: number;
        isFinal?: boolean;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? body.detail ?? `HTTP ${res.status}`);
      } else {
        setLastResult(
          `V${body.producedVersion ?? '?'} produziert${body.isFinal ? ' (final)' : ''}.`,
        );
        setStatus(body.isFinal ? 'done' : 'active');
        // Phase 01c-fix (2026-04-29): update the UI on-the-fly —
        // router.refresh() re-loads the server component so that the
        // entire page state (header badge, events list, sub-tickets)
        // shows current data, not just the StuckActions card.
        startTransition(() => router.refresh());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onCancel = async (): Promise<void> => {
    if (busy) return;
    if (!window.confirm('Workstream als done markieren? Kann nicht rückgängig gemacht werden.')) return;
    setBusy('cancel');
    setError(null);
    try {
      const res = await fetch(
        `/api/workstreams/${encodeURIComponent(workstreamId)}/cancel`,
        { method: 'POST' },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        setStatus('done');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stuck-actions">
      <div className="stuck-actions-icon" aria-hidden="true">
        <svg
          width={28}
          height={28}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable={false}
        >
          <path d="M10.3 3.9 2 18.5A1.9 1.9 0 0 0 3.7 21.3h16.6A1.9 1.9 0 0 0 22 18.5L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" />
          <path d="M12 9v4.5" />
          <path d="M12 17.2h.01" />
        </svg>
      </div>
      <div className="stuck-actions-body">
        <div className="stuck-actions-title">Workstream hängt</div>
        <p className="stuck-actions-hint">
          Letztes Event ist älter als die Pause-Dauer. Service wurde
          vermutlich während eines waitForSniperPause-Calls neu gestartet
          und der Process hat den Pause-Loop verlassen.
        </p>
        {lastResult ? (
          <p className="stuck-actions-result">{lastResult}</p>
        ) : null}
        {error ? <p className="stuck-actions-error">{error}</p> : null}
        <div className="stuck-actions-row">
          <button
            type="button"
            disabled={busy !== null}
            onClick={onResume}
            className="stuck-actions-btn stuck-actions-btn-primary"
          >
            {busy === 'resume' ? 'Resume läuft …' : 'Resume von V_letzte+1'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={onCancel}
            className="stuck-actions-btn"
          >
            {busy === 'cancel' ? 'Cancel läuft …' : 'Cancel + done markieren'}
          </button>
        </div>
      </div>
    </div>
  );
}
