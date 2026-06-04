'use client';

import { useState } from 'react';
import { QuickChoice } from '@/lib/ui/qck';

export interface TodayQuickActionProps {
  ticketId: string;
  ticketTitle: string;
}

/**
 * Inline QCK-action row for the first "today" ticket on the
 * calendar page. Interaction is local-only until Phase-4 event
 * emission wires up — once done/later/postpone become real
 * events, the submission handler below is the only site that
 * needs to change.
 */
export function TodayQuickAction({ ticketId, ticketTitle }: TodayQuickActionProps) {
  const [selected, setSelected] = useState<'ok' | 'later' | 'postpone' | null>(null);

  return (
    <div
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 12,
        border: '0.5px solid var(--line-2)',
        background: 'var(--sheet-2)',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--ink-3)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontFamily: 'var(--font-mono)',
          marginBottom: 10,
        }}
      >
        Schnellentscheidung · {ticketId}
      </div>
      <div
        style={{
          fontSize: 14,
          color: 'var(--ink)',
          letterSpacing: '-0.01em',
          marginBottom: 14,
        }}
      >
        {ticketTitle}
      </div>
      {selected ? (
        <div
          role="status"
          style={{
            fontSize: 13,
            color: 'var(--a-clientb)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.02em',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <svg
            width={14}
            height={14}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable={false}
          >
            <path d="M5 12.5l4 4 10-10" />
          </svg>
          <span>{labelFor(selected)} — gespeichert (lokal).</span>
        </div>
      ) : (
        <QuickChoice
          ariaLabel="Schnellentscheidung"
          options={[
            {
              id: 'ok',
              label: 'Ok',
              sublabel: 'erledigt',
              primary: true,
              onSelect: () => setSelected('ok'),
            },
            {
              id: 'later',
              label: 'Später',
              sublabel: 'heute noch',
              onSelect: () => setSelected('later'),
            },
            {
              id: 'postpone',
              label: 'Verschieben',
              sublabel: 'morgen',
              onSelect: () => setSelected('postpone'),
            },
          ]}
        />
      )}
    </div>
  );
}

function labelFor(a: 'ok' | 'later' | 'postpone'): string {
  switch (a) {
    case 'ok':
      return 'Als erledigt markiert';
    case 'later':
      return 'Auf Heute-Abend geschoben';
    case 'postpone':
      return 'Auf morgen verschoben';
  }
}
