'use client';

/**
 * TicketsFilterBar — Filter controls for the tickets list.
 *
 * Pushes to the URL as query params so the filter is shareable and
 * survives navigation. Server-Component `TicketsPage` re-renders on
 * URL-change because it reads `searchParams`.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useTransition } from 'react';
import type { ChangeEvent } from 'react';
import type { TicketStatus } from '@/lib/events/types';
import type { Workspace } from '@/lib/nav/types';

interface Props {
  workspaces: readonly Workspace[];
  totalCount: number;
}

const STATUS_OPTIONS: Array<{ value: TicketStatus | 'all'; label: string }> = [
  { value: 'all', label: 'Alle' },
  { value: 'open', label: 'Offen' },
  { value: 'wait', label: 'Wartet' },
  { value: 'danger', label: 'Kritisch' },
  { value: 'done', label: 'Erledigt' },
];

export function TicketsFilterBar({ workspaces, totalCount }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  const current = useMemo(
    () => ({
      workspaceId: params.get('workspaceId') ?? 'all',
      status: (params.get('status') as TicketStatus | 'all' | null) ?? 'all',
      query: params.get('query') ?? '',
    }),
    [params],
  );

  const push = useCallback(
    (patch: Partial<{ workspaceId: string; status: string; query: string }>) => {
      const next = new URLSearchParams(params.toString());
      if (patch.workspaceId !== undefined) {
        if (patch.workspaceId && patch.workspaceId !== 'all') {
          next.set('workspaceId', patch.workspaceId);
        } else {
          next.delete('workspaceId');
        }
      }
      if (patch.status !== undefined) {
        if (patch.status && patch.status !== 'all') {
          next.set('status', patch.status);
        } else {
          next.delete('status');
        }
      }
      if (patch.query !== undefined) {
        if (patch.query.trim()) {
          next.set('query', patch.query.trim());
        } else {
          next.delete('query');
        }
      }
      const search = next.toString();
      startTransition(() => {
        router.push(search ? `/tickets?${search}` : '/tickets');
      });
    },
    [params, router],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'center',
        padding: '12px 14px',
        borderRadius: 14,
        border: '0.5px solid var(--line-2)',
        background: 'var(--sheet-2)',
        marginTop: 24,
      }}
    >
      <label style={labelStyle}>
        <span style={labelTextStyle}>Workspace</span>
        <select
          style={selectStyle}
          value={current.workspaceId}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            push({ workspaceId: e.target.value })
          }
        >
          <option value="all">Alle</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        <span style={labelTextStyle}>Status</span>
        <select
          style={selectStyle}
          value={current.status}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            push({ status: e.target.value })
          }
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label style={{ ...labelStyle, flex: '1 1 200px' }}>
        <span style={labelTextStyle}>Suche</span>
        <input
          type="search"
          placeholder="Titel, Body, ID…"
          defaultValue={current.query}
          onBlur={(e) => {
            if (e.target.value.trim() !== current.query.trim()) {
              push({ query: e.target.value });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              push({ query: (e.target as HTMLInputElement).value });
            }
          }}
          style={{ ...selectStyle, minWidth: 160 }}
        />
      </label>

      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--ink-3)',
          marginLeft: 'auto',
        }}
      >
        {pending ? 'Lade…' : `${totalCount} Treffer`}
      </span>
    </div>
  );
}

const labelStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 4,
  fontSize: 11,
  color: 'var(--ink-3)',
};

const labelTextStyle = {
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
};

const selectStyle = {
  background: 'var(--sheet-3)',
  border: '0.5px solid var(--line-2)',
  color: 'var(--ink)',
  fontSize: 13,
  borderRadius: 8,
  padding: '8px 10px',
  minWidth: 140,
  appearance: 'auto' as const,
};
