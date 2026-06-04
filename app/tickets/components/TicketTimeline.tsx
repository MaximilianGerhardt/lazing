/**
 * TicketTimeline — chronological event feed for a single ticket.
 *
 * Server-component friendly — no client state. Receives pre-fetched
 * events from the page. Renders as a vertical timeline with a type-
 * color pill, actor, and payload-summary.
 */

import type { CSSProperties } from 'react';
import type { LazyEvent } from '@/lib/events/types';

interface Props {
  events: LazyEvent[];
}

const EVENT_LABELS: Partial<Record<LazyEvent['eventType'], string>> = {
  created: 'Erstellt',
  updated: 'Geändert',
  status_changed: 'Status',
  closed: 'Geschlossen',
  reopened: 'Wieder geöffnet',
  assigned: 'Zugewiesen',
  commented: 'Kommentar',
  review_request: 'Review angefordert',
  user_feedback: 'User-Feedback',
  fix_agent_triggered: 'Fix-Agent',
  approval_requested: 'Freigabe angefragt',
  approved: 'Freigegeben',
  rejected: 'Abgelehnt',
  executed: 'Ausgeführt',
  test_result: 'Test-Ergebnis',
  error_logged: 'Fehler',
};

const EVENT_COLORS: Partial<Record<LazyEvent['eventType'], string>> = {
  created: 'var(--a-clientb)',
  closed: 'var(--ink-3)',
  status_changed: 'var(--a-now)',
  commented: 'var(--a-private)',
  user_feedback: 'var(--a-own)',
  rejected: 'var(--a-danger)',
  error_logged: 'var(--a-danger)',
  approved: 'var(--a-clientb)',
};

export function TicketTimeline({ events }: Props) {
  if (events.length === 0) {
    return (
      <p style={{ color: 'var(--ink-3)', fontSize: 13 }}>
        Noch keine Events — sobald etwas passiert, taucht es hier auf.
      </p>
    );
  }

  // Chronological oldest-first (service already returns ascending).
  return (
    <ol
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gap: 14,
        position: 'relative',
      }}
    >
      {events.map((ev, i) => {
        const label = EVENT_LABELS[ev.eventType] ?? ev.eventType;
        const color = EVENT_COLORS[ev.eventType] ?? 'var(--ink-2)';
        const isLast = i === events.length - 1;
        return (
          <li key={ev.id} style={itemStyle}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ position: 'relative', paddingTop: 4 }}>
                <span
                  style={{
                    display: 'block',
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    background: color,
                    boxShadow: `0 0 0 3px var(--sheet-2)`,
                  }}
                />
                {!isLast ? (
                  <span
                    style={{
                      position: 'absolute',
                      top: 16,
                      left: 4,
                      bottom: -18,
                      width: 2,
                      background: 'var(--line-2)',
                    }}
                    aria-hidden
                  />
                ) : null}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: color,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {label}
                  </span>
                  <span style={metaStyle}>{formatActor(ev.actor)}</span>
                  <span style={metaStyle}>{formatTime(ev.createdAt)}</span>
                </div>
                {renderPayload(ev)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function renderPayload(ev: LazyEvent): React.ReactNode {
  const p = ev.payload ?? {};
  const lines: string[] = [];

  if (ev.eventType === 'status_changed') {
    const next = typeof p.status === 'string' ? p.status : null;
    const prev = typeof p.previousStatus === 'string' ? p.previousStatus : null;
    if (prev && next) lines.push(`${prev} → ${next}`);
    else if (next) lines.push(next);
  } else if (ev.eventType === 'commented') {
    const text = typeof p.text === 'string' ? p.text : '';
    if (text) {
      return (
        <p
          style={{
            marginTop: 6,
            fontSize: 13,
            color: 'var(--ink)',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
          }}
        >
          {text}
        </p>
      );
    }
  } else if (ev.eventType === 'created' || ev.eventType === 'updated') {
    for (const [k, v] of Object.entries(p)) {
      if (k === 'title' || k === 'body') continue;
      const val = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
      if (val && val !== '{}') lines.push(`${k}: ${val}`);
    }
    if (typeof p.title === 'string') lines.unshift(`Titel: ${p.title}`);
  } else if (ev.eventType === 'user_feedback') {
    if (typeof p.quickAction === 'string') lines.push(`Action: ${p.quickAction}`);
    if (typeof p.text === 'string' && p.text) lines.push(`„${p.text}"`);
  } else if (ev.eventType === 'error_logged') {
    if (typeof p.message === 'string') lines.push(p.message);
  }

  if (lines.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 4,
        fontSize: 12,
        color: 'var(--ink-2)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
      }}
    >
      {lines.join('\n')}
    </div>
  );
}

function formatActor(a: string): string {
  if (a === 'system') return 'System';
  if (a.startsWith('user:')) return a.slice(5);
  if (a.startsWith('agent:')) return `Agent ${a.slice(6)}`;
  return a;
}

function formatTime(ts: number): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

const itemStyle: CSSProperties = {
  paddingBottom: 4,
};

const metaStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  letterSpacing: '0.02em',
};
