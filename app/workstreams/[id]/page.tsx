/**
 * /workstreams/[id] — Workstream-Detail-Hub.
 *
 * Zeigt:
 *   - Header: Name, Workspace, Status, Cost, Quality, Tier-Mix
 *   - Master-Plan-Ticket (mit Link zur Detail-Page)
 *   - Sub-Tickets-Hierarchie (parent_ticket_id)
 *   - Aktive Session mit Fortsetzen-Button
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';

import { getWorkstream } from '@/lib/workstreams/service';
import { listTickets } from '@/lib/tickets/service';
import { getWorkspace } from '@/lib/workspaces';
import { ContextBand } from '@/lib/ui/cbd';
import { Pill, type PillVariant } from '@/lib/ui/pil';
import { TicketSessionRefs } from '@/app/tickets/components/TicketSessionRefs';
import type { TicketProjection } from '@/lib/events/types';
import { SniperInjectCard } from './SniperInjectCard';
import { StuckActions } from './StuckActions';
import { ReasoningTrailCard } from '@/app/components/agents/ReasoningTrailCard';

export const dynamic = 'force-dynamic';

export default async function WorkstreamDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  // getWorkstream darf null liefern → notFound. Throws (DB-Fehler) bubbeln zu error.tsx.
  let ws: Awaited<ReturnType<typeof getWorkstream>>;
  try {
    ws = await getWorkstream(id);
  } catch (err) {
    console.error('[workstreams/[id]] getWorkstream failed', { id, err });
    throw err;
  }
  if (!ws) notFound();

  // Defensive: Workspace + Tickets dürfen failen ohne die Page zu killen.
  const workspace = await getWorkspace(ws.workspaceId).catch((err) => {
    console.warn('[workstreams/[id]] getWorkspace failed', err);
    return null;
  });
  const allTickets = await listTickets({ workspaceId: ws.workspaceId }).catch(
    (err) => {
      console.warn('[workstreams/[id]] listTickets failed', err);
      return [] as TicketProjection[];
    },
  );
  const tickets = allTickets.filter((t) => t.workstreamId === id);

  const masterTicket = tickets.find((t) => t.id === ws.primaryTicketId) ?? null;
  const featureTickets = tickets.filter(
    (t) =>
      t.id !== ws.primaryTicketId &&
      (t.parentTicketId === ws.primaryTicketId || !t.parentTicketId),
  );
  const segmentByFeature = new Map<string, TicketProjection[]>();
  for (const t of tickets) {
    if (!t.parentTicketId) continue;
    if (t.parentTicketId === ws.primaryTicketId) continue;
    const arr = segmentByFeature.get(t.parentTicketId) ?? [];
    arr.push(t);
    segmentByFeature.set(t.parentTicketId, arr);
  }

  const accent: PillVariant = (workspace?.accent as PillVariant) ?? 'own';

  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={{ maxWidth: 1080 }}>
        <ContextBand
          pillVariant={accent}
          pillLabel={workspace?.label ?? ws.workspaceId}
          breadcrumb={`Workstream · ${ws.id}`}
        />

        <SniperInjectCard workstreamId={ws.id} status={ws.status} />
        <StuckActions workstreamId={ws.id} initialStatus={ws.status} />
        <ReasoningTrailCard workstreamId={ws.id} />

        <div style={headerStyle}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={badgeRowStyle}>
              <span style={statusBadgeStyle(ws.status)}>{ws.status}</span>
              {ws.tierMix ? (
                <span style={tierMixStyle}>
                  Opus {ws.tierMix.opus} · Sonnet {ws.tierMix.sonnet} · Haiku{' '}
                  {ws.tierMix.haiku}
                </span>
              ) : (
                <span style={{ ...tierMixStyle, color: 'var(--ink-3)' }}>
                  noch kein Tier-Mix
                </span>
              )}
            </div>
            <h1
              className="t-h1"
              style={{
                marginTop: 8,
                fontSize: 'clamp(24px, 3.4vw, 34px)',
                letterSpacing: '-0.02em',
                lineHeight: 1.2,
              }}
            >
              {ws.name}
            </h1>
            {ws.description ? (
              <p style={{ color: 'var(--ink-2)', marginTop: 8 }}>{ws.description}</p>
            ) : null}
          </div>
          <div style={metaCardStyle}>
            <MetaRow label="Cost (≈ API)">
              {ws.costCents > 0
                ? `€${(ws.costCents / 100).toFixed(2)}`
                : '— (MAX-Plan)'}
            </MetaRow>
            <MetaRow label="Qualität">
              {ws.qualityScore !== null ? (
                <span
                  style={{
                    color: 'var(--a-warn)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <svg
                    width={14}
                    height={14}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable={false}
                  >
                    <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z" />
                  </svg>
                  {ws.qualityScore.toFixed(1)}/5
                </span>
              ) : (
                '—'
              )}
            </MetaRow>
            <MetaRow label="ID">
              <code style={codeStyle}>{ws.id}</code>
            </MetaRow>
          </div>
        </div>

        {ws.primarySessionId ? (
          <div style={{ marginTop: 22 }}>
            <TicketSessionRefs
              sessionRefs={[ws.primarySessionId]}
              workspaceId={ws.workspaceId}
            />
          </div>
        ) : null}

        {/* Master-Plan-Ticket */}
        <section style={sectionStyle}>
          <SectionHeader>Master-Plan-Ticket</SectionHeader>
          {masterTicket ? (
            <TicketCard ticket={masterTicket} accent="primary" />
          ) : (
            <div style={emptyInline}>
              Noch kein Master-Ticket — wird beim Tier-Mix-Klick angelegt.
            </div>
          )}
        </section>

        {/* Feature-Tickets */}
        {featureTickets.length > 0 ? (
          <section style={sectionStyle}>
            <SectionHeader>Feature-Pläne ({featureTickets.length})</SectionHeader>
            <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
              {featureTickets.map((t) => {
                const segments = segmentByFeature.get(t.id) ?? [];
                return (
                  <div key={t.id}>
                    <TicketCard ticket={t} accent="feature" />
                    {segments.length > 0 ? (
                      <div style={{ marginLeft: 32, marginTop: 8, display: 'grid', gap: 6 }}>
                        {segments.map((s) => (
                          <TicketCard key={s.id} ticket={s} accent="segment" />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {tickets.length === 0 ? (
          <div style={emptyStyle}>
            Noch keine Tickets in diesem Workstream. Spawn einen Master-Plan
            via Tier-Mix-Card im Chat.
          </div>
        ) : null}
      </section>
    </main>
  );
}

function TicketCard({
  ticket,
  accent,
}: {
  ticket: TicketProjection;
  accent: 'primary' | 'feature' | 'segment';
}) {
  const borderColor =
    accent === 'primary'
      ? 'var(--a-now)'
      : accent === 'feature'
        ? 'var(--ink-2)'
        : 'var(--line-2)';
  const bg =
    accent === 'primary'
      ? 'color-mix(in oklab, var(--a-now) 8%, var(--sheet-2))'
      : 'var(--sheet-2)';
  return (
    <Link
      href={`/tickets/${encodeURIComponent(ticket.id)}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 12,
        border: `0.5px solid ${borderColor}`,
        background: bg,
        textDecoration: 'none',
        color: 'inherit',
        marginTop: accent === 'primary' ? 10 : 0,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={codeStyle}>{ticket.id}</code>
          {ticket.prio ? (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)' }}>
              {ticket.prio}
            </span>
          ) : null}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)' }}>
            {ticket.status}
          </span>
        </div>
        <div style={{ marginTop: 4, fontSize: 14, color: 'var(--ink)' }}>
          {ticket.title}
        </div>
      </div>
      <span style={{ color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        →
      </span>
    </Link>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--ink-3)',
      }}
    >
      {children}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 12 }}>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-3)', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--ink)' }}>{children}</span>
    </div>
  );
}

function statusBadgeStyle(status: string): CSSProperties {
  const color =
    status === 'active'
      ? 'var(--a-now)'
      : status === 'done'
        ? 'var(--a-clientb)'
        : status === 'archived'
          ? 'var(--ink-4)'
          : 'var(--ink-3)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    padding: '3px 10px',
    borderRadius: 6,
    color,
    border: `0.5px solid ${color}`,
    letterSpacing: '0.04em',
  };
}

const headerStyle: CSSProperties = {
  marginTop: 22,
  display: 'flex',
  gap: 24,
  flexWrap: 'wrap',
  alignItems: 'flex-start',
};

const badgeRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  flexWrap: 'wrap',
};

const tierMixStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '3px 8px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--a-now) 10%, transparent)',
  color: 'var(--a-now)',
  letterSpacing: '0.04em',
};

const metaCardStyle: CSSProperties = {
  flex: '0 0 280px',
  padding: '14px 16px',
  borderRadius: 12,
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const sectionStyle: CSSProperties = {
  marginTop: 28,
};

const emptyStyle: CSSProperties = {
  marginTop: 28,
  padding: 22,
  borderRadius: 12,
  border: '0.5px dashed var(--line-2)',
  textAlign: 'center',
  color: 'var(--ink-3)',
  fontSize: 13,
};

const emptyInline: CSSProperties = {
  marginTop: 10,
  padding: '12px 14px',
  borderRadius: 10,
  border: '0.5px dashed var(--line-2)',
  color: 'var(--ink-3)',
  fontSize: 13,
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  background: 'var(--sheet-3)',
  padding: '2px 6px',
  borderRadius: 4,
};
