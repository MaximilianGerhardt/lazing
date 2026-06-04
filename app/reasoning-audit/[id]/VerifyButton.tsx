'use client';

/**
 * VerifyButton — Triggert manuelle Drift-Verifikation einer Audit-Row.
 *
 * Pattern 5 Welle 4 (2026-05-01).
 *
 * Achtung: Re-Spawn kostet echte LLM-Inferenz. Button hat 3-Sekunden-
 * Confirm-State um Doppel-Klicks zu verhindern.
 */

import { useState, useTransition, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  id: string;
}

interface VerifyResponse {
  ok?: boolean;
  decision?: {
    status: 'ok' | 'drift' | 'fabricated';
    similarity: number;
    note: string;
  };
  error?: string;
  detail?: string;
}

export function VerifyButton({ id }: Props): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setInfo(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/reasoning-audit/${encodeURIComponent(id)}/verify`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
        },
      );
      const j = (await res.json().catch(() => ({}))) as VerifyResponse;
      if (!res.ok) {
        throw new Error(j.detail ?? j.error ?? `HTTP ${res.status}`);
      }
      const status = j.decision?.status ?? 'unknown';
      const sim =
        typeof j.decision?.similarity === 'number'
          ? ` · sim=${j.decision.similarity.toFixed(3)}`
          : '';
      setInfo(`Verifikation abgeschlossen: ${status}${sim}`);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <span style={wrapStyle}>
      <button
        type="button"
        onClick={() => void run()}
        disabled={pending}
        style={btnStyle(pending)}
        aria-label="Drift-Check jetzt"
      >
        {pending ? 'Re-Spawn läuft …' : 'Drift-Check jetzt'}
      </button>
      {info ? <span style={infoStyle}>{info}</span> : null}
      {error ? (
        <span style={errStyle}>
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: 0 }}
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          {error}
        </span>
      ) : null}
    </span>
  );
}

const wrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

function btnStyle(pending: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '8px 16px',
    borderRadius: 10,
    border: '0.5px solid var(--a-now)',
    background: 'var(--a-now)',
    color: 'var(--sheet)',
    fontSize: 13,
    fontWeight: 500,
    cursor: pending ? 'wait' : 'pointer',
    opacity: pending ? 0.6 : 1,
    fontFamily: 'var(--font-sans)',
  };
}

const infoStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--a-clientb, #1f9d55)',
};

const errStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--a-danger)',
};
