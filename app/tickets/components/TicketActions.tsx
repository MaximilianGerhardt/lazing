'use client';

/**
 * TicketActions — Status-dropdown + Close-Button on the detail page.
 *
 * PATCHes `/api/tickets/:id` for status changes, DELETEs for close.
 * On success triggers `router.refresh()` so the server component
 * re-projects the ticket from the event log.
 */

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { TicketStatus } from '@/lib/events/types';

interface Props {
  ticketId: string;
  currentStatus: TicketStatus;
}

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Offen',
  wait: 'Wartet',
  danger: 'Kritisch',
  done: 'Erledigt',
};

export function TicketActions({ ticketId, currentStatus }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<null | 'status' | 'close'>(null);
  const [error, setError] = useState<string | null>(null);

  const changeStatus = useCallback(
    async (next: TicketStatus) => {
      if (next === currentStatus) return;
      setPending('status');
      setError(null);
      try {
        const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            payload?.message ?? payload?.error ?? `HTTP ${res.status}`,
          );
        }
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Fehler');
      } finally {
        setPending(null);
      }
    },
    [currentStatus, router, ticketId],
  );

  const closeTicket = useCallback(async () => {
    if (currentStatus === 'done') return;
    if (!confirm('Ticket schliessen? Wird als `closed`-Event geloggt.')) return;
    setPending('close');
    setError(null);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(
          payload?.message ?? payload?.error ?? `HTTP ${res.status}`,
        );
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fehler');
    } finally {
      setPending(null);
    }
  }, [currentStatus, router, ticketId]);

  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 13,
          color: 'var(--ink-2)',
        }}
      >
        Status
        <select
          value={currentStatus}
          disabled={pending !== null}
          onChange={(e) => changeStatus(e.target.value as TicketStatus)}
          style={{
            background: 'var(--sheet-3)',
            border: '0.5px solid var(--line-2)',
            color: 'var(--ink)',
            fontSize: 13,
            borderRadius: 8,
            padding: '8px 10px',
            minWidth: 120,
          }}
        >
          {(Object.keys(STATUS_LABELS) as TicketStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={closeTicket}
        disabled={pending !== null || currentStatus === 'done'}
        style={{
          padding: '8px 14px',
          background: 'transparent',
          color: currentStatus === 'done' ? 'var(--ink-3)' : 'var(--ink-2)',
          border: '0.5px solid var(--line-2)',
          borderRadius: 8,
          fontSize: 13,
          cursor: currentStatus === 'done' ? 'not-allowed' : 'pointer',
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending === 'close'
          ? 'Schliesse…'
          : currentStatus === 'done'
            ? 'Geschlossen'
            : 'Schliessen'}
      </button>

      {error ? (
        <span
          role="alert"
          style={{
            color: 'var(--a-danger)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
