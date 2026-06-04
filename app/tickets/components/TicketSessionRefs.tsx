'use client';

/**
 * TicketSessionRefs — shows Claude sessions that have worked on this ticket
 * (handoff point 5). Click → the resume endpoint takes over the session
 * as the active chat session for the workspace, navigating to `/`.
 */

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  sessionRefs: string[];
  workspaceId: string;
}

export function TicketSessionRefs({ sessionRefs, workspaceId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!sessionRefs || sessionRefs.length === 0) return null;

  const resume = async (uuid: string): Promise<void> => {
    setBusy(uuid);
    setError(null);
    try {
      const resp = await fetch(
        `/api/sessions/${encodeURIComponent(uuid)}/resume`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId }),
        },
      );
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler');
      setBusy(null);
    }
  };

  return (
    <section style={wrapStyle}>
      <div style={headerStyle}>
        Chat-Kontext · {sessionRefs.length} Session
        {sessionRefs.length === 1 ? '' : 's'}
      </div>
      <ul style={listStyle}>
        {sessionRefs.map((uuid) => (
          <li key={uuid} style={itemStyle}>
            <code style={uuidStyle}>{shortUuid(uuid)}</code>
            <button
              type="button"
              onClick={() => void resume(uuid)}
              disabled={busy === uuid}
              style={btnStyle}
            >
              {busy === uuid ? 'Lade …' : 'Fortsetzen'}
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <div role="alert" style={errStyle}>
          {error}
        </div>
      ) : null}
    </section>
  );
}

function shortUuid(u: string): string {
  if (u.length <= 12) return u;
  return `${u.slice(0, 8)}…${u.slice(-4)}`;
}

const wrapStyle: CSSProperties = {
  marginTop: 20,
  padding: '12px 14px',
  borderRadius: 12,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--a-now) 6%, var(--sheet-2))',
};

const headerStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--ink-3)',
  marginBottom: 8,
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
};

const uuidStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  background: 'var(--sheet-3)',
  padding: '3px 7px',
  borderRadius: 5,
};

const btnStyle: CSSProperties = {
  padding: '5px 12px',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--a-now)',
  border: '0.5px solid var(--a-now)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const errStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 11,
  color: 'var(--a-danger)',
};
