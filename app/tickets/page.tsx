/**
 * /tickets — List view (Server Component).
 *
 * Lists tickets with filter bar + Quick-Create FAB. Reads workspaces
 * from the DB (falls back to static list) and tickets via the safe
 * projection layer. Empty state when no tickets — no mock data.
 */

import Link from 'next/link';

import { ContextBand } from '@/lib/ui/cbd';
import { safeProjectTickets } from '@/lib/events/safe-projection';
import type { TicketProjection, TicketStatus } from '@/lib/events/types';
import { listWorkspaces } from '@/lib/workspaces';
import { STATIC_WORKSPACES } from '@/lib/nav/workspaces-data';
import type { Workspace as NavWorkspace, WorkspaceAccent } from '@/lib/nav/types';

import { TicketsFilterBar } from './components/TicketsFilterBar';
import { QuickCreateDrawer } from './components/QuickCreateDrawer';

export const dynamic = 'force-dynamic';

interface Search {
  workspaceId?: string;
  status?: TicketStatus | 'all';
  query?: string;
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filters: Search = {
    workspaceId: typeof sp.workspaceId === 'string' ? sp.workspaceId : undefined,
    status:
      typeof sp.status === 'string'
        ? (sp.status as TicketStatus | 'all')
        : undefined,
    query: typeof sp.query === 'string' ? sp.query : undefined,
  };

  const [rawWorkspaces, tickets] = await Promise.all([
    safeListWorkspaces(),
    safeProjectTickets(filters.workspaceId),
  ]);
  const workspaces = rawWorkspaces;
  const filtered = applyFilters(tickets, filters);
  const openCount = filtered.filter((t) => t.status !== 'done').length;

  return (
    <main className="sheet" style={{ paddingBottom: 140 }}>
      <section style={{ maxWidth: 1100, marginTop: 'clamp(20px, 4vw, 48px)' }}>
        <ContextBand
          pillVariant="own"
          pillLabel="Tickets"
          breadcrumb={`Event-Sourced · ${openCount} offen · ${filtered.length} sichtbar`}
        />

        <div style={{ marginTop: 22 }}>
          <h1
            className="t-h1"
            style={{
              fontSize: 'clamp(28px, 4vw, 40px)',
              letterSpacing: '-0.02em',
              maxWidth: 780,
            }}
          >
            Jede Arbeit ist ein{' '}
            <em style={{ fontStyle: 'italic', fontWeight: 300, color: 'var(--ink-2)' }}>
              Ticket
            </em>
            . Jedes Ticket ist ein Event-Strom.
          </h1>
          <p
            style={{
              marginTop: 12,
              maxWidth: 620,
              fontSize: 14,
              lineHeight: 1.55,
              color: 'var(--ink-2)',
            }}
          >
            Append-only — geschlossene Tickets werden nicht gelöscht. Jede Änderung
            ist in der Timeline nachvollziehbar.
          </p>
        </div>

        <TicketsFilterBar workspaces={workspaces} totalCount={filtered.length} />

        <div style={{ marginTop: 18 }}>
          {filtered.length === 0 ? (
            <EmptyState filters={filters} />
          ) : (
            <ul
              role="list"
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: 12,
              }}
            >
              {filtered.map((t) => (
                <TicketRow
                  key={t.id}
                  ticket={t}
                  workspaceLabel={
                    workspaces.find((w) => w.id === t.segmentId)?.label ??
                    t.segmentId
                  }
                  workspaceAccent={
                    workspaces.find((w) => w.id === t.segmentId)?.accent ?? 'own'
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      <QuickCreateDrawer
        workspaces={workspaces}
        defaultWorkspaceId={filters.workspaceId}
      />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function TicketRow({
  ticket,
  workspaceLabel,
  workspaceAccent,
}: {
  ticket: TicketProjection;
  workspaceLabel: string;
  workspaceAccent: WorkspaceAccent;
}) {
  return (
    <li>
      <Link
        href={`/tickets/${encodeURIComponent(ticket.id)}`}
        style={{
          display: 'block',
          textDecoration: 'none',
          color: 'inherit',
        }}
      >
        <article
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 12,
            padding: '14px 16px 14px 14px',
            borderRadius: 14,
            border: '0.5px solid var(--line-2)',
            background: 'var(--sheet-2)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 3,
              background: accentVar(workspaceAccent),
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 88 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-caption)',  /* 11px — ticket-ID as caption, uppercase-like */
                color: 'var(--ink-3)',
                letterSpacing: '0.02em',
              }}
            >
              {ticket.id.split('-').slice(0, 2).join('-')}
            </span>
            <StatusPill status={ticket.status} />
          </div>

          <div style={{ minWidth: 0 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 500,
                color: 'var(--ink)',
                letterSpacing: '-0.005em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {ticket.title}
            </h3>
            <div
              style={{
                marginTop: 4,
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                fontSize: 'var(--fs-body)',
                color: 'var(--ink-2)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span style={{ color: accentVar(workspaceAccent) }}>
                {workspaceLabel}
              </span>
              {ticket.assignee ? <span>· {ticket.assignee}</span> : null}
              {ticket.due ? <span>· fällig {ticket.due}</span> : null}
              {ticket.tags.length > 0 ? (
                <span>· {ticket.tags.slice(0, 3).join(', ')}</span>
              ) : null}
            </div>
          </div>

          {ticket.prio ? (
            <span
              style={{
                alignSelf: 'center',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 6,
                color: prioColor(ticket.prio),
                border: `0.5px solid ${prioColor(ticket.prio)}`,
                letterSpacing: '0.04em',
              }}
            >
              {ticket.prio}
            </span>
          ) : null}
        </article>
      </Link>
    </li>
  );
}

function StatusPill({ status }: { status: TicketStatus }) {
  const map: Record<TicketStatus, { label: string; color: string }> = {
    open: { label: 'Offen', color: 'var(--a-now)' },
    wait: { label: 'Wartet', color: 'var(--ink-3)' },
    danger: { label: 'Kritisch', color: 'var(--a-danger)' },
    done: { label: 'Erledigt', color: 'var(--a-clientb)' },
  };
  const { label, color } = map[status];
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 4,
        color,
        background: 'transparent',
        border: `0.5px solid ${color}`,
        alignSelf: 'flex-start',
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </span>
  );
}

function accentVar(accent: WorkspaceAccent): string {
  switch (accent) {
    case 'north':
      return 'var(--a-north)';
    case 'clientb':
      return 'var(--a-clientb)';
    case 'private':
      return 'var(--a-private)';
    case 'own':
    default:
      return 'var(--a-own)';
  }
}

function prioColor(prio: string): string {
  if (prio.startsWith('P0')) return 'var(--a-danger)';
  if (prio.startsWith('P1')) return 'var(--a-now)';
  if (prio.startsWith('P2')) return 'var(--ink-2)';
  return 'var(--ink-3)';
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ filters }: { filters: Search }) {
  const hasFilters =
    filters.workspaceId ||
    (filters.status && filters.status !== 'all') ||
    (filters.query && filters.query.trim().length > 0);

  if (hasFilters) {
    return (
      <div
        style={{
          padding: '48px 20px',
          textAlign: 'center',
          border: '0.5px dashed var(--line-2)',
          borderRadius: 16,
          background: 'var(--sheet-2)',
        }}
      >
        <div
          style={{
            fontSize: 13,
            fontFamily: 'var(--font-mono)',
            color: 'var(--ink-3)',
            letterSpacing: '0.04em',
          }}
        >
          KEINE TREFFER
        </div>
        <h2
          style={{
            marginTop: 10,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: '-0.01em',
            color: 'var(--ink)',
          }}
        >
          Keine Tickets für diese Filter.
        </h2>
        <p
          style={{
            marginTop: 8,
            fontSize: 14,
            color: 'var(--ink-2)',
            maxWidth: 420,
            margin: '8px auto 0',
          }}
        >
          Filter lockern oder neues Ticket anlegen (+ rechts unten).
        </p>
      </div>
    );
  }

  // Zero-inbox — minimal, honest empty state. No ghost examples,
  // no „this is how it could look" pedagogy. One headline, one sentence, one CTA.
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '72px 20px',
        gap: 10,
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 500,
          letterSpacing: '-0.01em',
          color: 'var(--ink)',
        }}
      >
        Noch keine Tickets.
      </h2>
      <p
        style={{
          margin: 0,
          fontSize: 14,
          color: 'var(--ink-2)',
          maxWidth: 420,
          lineHeight: 1.55,
        }}
      >
        Leg dein erstes Ticket an — oder sag im Chat, was ansteht.
      </p>
      <Link
        href="/tickets/new"
        style={{
          marginTop: 18,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 22px',
          borderRadius: 12,
          border: '0.5px solid var(--a-now)',
          background: 'color-mix(in oklab, var(--a-now) 12%, transparent)',
          fontSize: 15,
          fontWeight: 500,
          color: 'var(--ink)',
          textDecoration: 'none',
          letterSpacing: '-0.01em',
        }}
      >
        <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
          +
        </span>
        Neues Ticket
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeListWorkspaces(): Promise<readonly NavWorkspace[]> {
  try {
    const ws = await listWorkspaces();
    if (ws.length === 0) return STATIC_WORKSPACES;
    return ws.map((w) => ({
      id: w.id,
      label: w.label,
      accent: w.accent,
      sensitivity: (w.sensitivity === 'medium' ? 'normal' : w.sensitivity) as
        | 'low'
        | 'normal'
        | 'high',
      archived: w.archived,
    }));
  } catch {
    return STATIC_WORKSPACES;
  }
}

function applyFilters(
  tickets: TicketProjection[],
  filters: Search,
): TicketProjection[] {
  let out = tickets;
  if (filters.status && filters.status !== 'all') {
    out = out.filter((t) => t.status === filters.status);
  }
  if (filters.query) {
    const q = filters.query.trim().toLowerCase();
    if (q.length > 0) {
      out = out.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          (t.body?.toLowerCase().includes(q) ?? false),
      );
    }
  }
  return out;
}
