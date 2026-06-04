'use client';

/**
 * TicketDeleteButton — Hart-Delete mit Confirm-Dialog.
 *
 * Ruft POST /api/tickets/:id/delete-hard (emits `ticket_deleted`-Event,
 * entfernt Projection). Navigiert danach zu /tickets.
 */

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  ticketId: string;
  title: string;
}

export function TicketDeleteButton({ ticketId, title }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const confirmDelete = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/delete-hard`,
        { method: 'POST' },
      );
      if (!resp.ok) {
        const data = (await resp.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }
      router.push('/tickets');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler');
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={triggerStyle}
        title="Ticket unwiderruflich entfernen"
      >
        Entfernen
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ticket entfernen?"
          style={backdropStyle}
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div style={dialogStyle}>
            <h3 style={{ margin: 0, fontSize: 18, color: 'var(--ink)' }}>
              Ticket entfernen?
            </h3>
            <p style={{ margin: '8px 0 14px', fontSize: 13, color: 'var(--ink-2)' }}>
              „{title}" wird hart gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
              Das Event-Log behält eine `ticket_deleted`-Spur.
            </p>
            {error ? (
              <div role="alert" style={errStyle}>
                {error}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={busy}
                style={cancelBtnStyle}
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={busy}
                style={dangerBtnStyle}
              >
                {busy ? 'Lösche …' : 'Endgültig entfernen'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const triggerStyle: CSSProperties = {
  background: 'transparent',
  border: '0.5px solid var(--a-danger)',
  color: 'var(--a-danger)',
  padding: '6px 12px',
  borderRadius: 999,
  fontSize: 12,
  letterSpacing: '-0.01em',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const backdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'color-mix(in oklab, var(--sheet) 70%, transparent)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  zIndex: 80,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
};

const dialogStyle: CSSProperties = {
  maxWidth: 420,
  width: '100%',
  padding: 22,
  borderRadius: 16,
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
};

const cancelBtnStyle: CSSProperties = {
  background: 'transparent',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  padding: '8px 14px',
  borderRadius: 10,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const dangerBtnStyle: CSSProperties = {
  background: 'var(--a-danger)',
  border: 'none',
  color: 'var(--sheet)',
  padding: '8px 14px',
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const errStyle: CSSProperties = {
  marginBottom: 12,
  padding: '8px 10px',
  borderRadius: 8,
  background: 'color-mix(in oklab, var(--a-danger) 10%, transparent)',
  border: '0.5px solid var(--a-danger)',
  color: 'var(--ink)',
  fontSize: 12,
};
