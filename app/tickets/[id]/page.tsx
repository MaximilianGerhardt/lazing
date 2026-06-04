/**
 * /tickets/[id] — Ticket detail view (Server Component).
 *
 * Re-projects from the event log on every request (force-dynamic) so
 * freshly-appended events appear without a cache bust. Renders:
 *   - Header row: TCK-id, status, priority, workspace-pill
 *   - Markdown body (pre-rendered server-side, simple pre-wrap — we
 *     don't ship react-markdown to the client until it's actually
 *     needed; when installed, swap the <Body/> implementation)
 *   - Meta panel (assignee, due, tags, timestamps)
 *   - Timeline (delegated to <TicketTimeline/>)
 *   - Action row (status dropdown + close)
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties } from 'react';

import { ContextBand } from '@/lib/ui/cbd';
import { Pill } from '@/lib/ui/pil';
import type { PillVariant } from '@/lib/ui/pil';
import {
  TicketNotFoundError,
  getTicket,
  getTimeline,
} from '@/lib/tickets/service';
import { getWorkspace } from '@/lib/workspaces';
import { IconWorkstreams } from '@/lib/nav/icons';
import type { LazyEvent, TicketStatus } from '@/lib/events/types';

import { TicketActions } from '../components/TicketActions';
import { TicketTimeline } from '../components/TicketTimeline';
import { TicketThread } from '../components/TicketThread';
import { TicketReplyBox } from '../components/TicketReplyBox';
import { TicketDeleteButton } from '../components/TicketDeleteButton';
import { TicketSessionRefs } from '../components/TicketSessionRefs';
import { TicketBody } from '../components/TicketBody';
import { listWorkProducts } from '@/lib/work-products/service';
import { TicketDetailTabs } from './TicketDetailTabs';
import { WorkflowPipeline } from './WorkflowPipeline';
import type { WorkflowState } from '@/lib/approvals/fsm';

export const dynamic = 'force-dynamic';

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: rawId } = await params;
  const id = decodeURIComponent(rawId);

  const ticket = await getTicket(id);
  if (!ticket) notFound();

  // Parallel fetch timeline + workspace metadata.
  let timeline: LazyEvent[] = [];
  try {
    timeline = await getTimeline(id);
  } catch (err) {
    if (err instanceof TicketNotFoundError) notFound();
    timeline = [];
  }
  const workspace = await getWorkspace(ticket.segmentId).catch(() => null);
  const workProducts = await listWorkProducts(ticket.id).catch(() => []);
  const workspaceLabel = workspace?.label ?? ticket.segmentId;
  const pillVariant: PillVariant = pillVariantForAccent(
    workspace?.accent ?? 'own',
  );

  return (
    <main className="sheet" style={{ paddingBottom: 120 }}>
      <section
        style={{ maxWidth: 980, marginTop: 'clamp(20px, 4vw, 48px)' }}
      >
        <ContextBand
          pillVariant={pillVariant}
          pillLabel={workspaceLabel}
          breadcrumb={`Ticket · ${ticket.id}`}
        />

        <div
          style={{
            marginTop: 22,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <StatusBadge status={ticket.status} />
              {ticket.prio ? <PrioBadge prio={ticket.prio} /> : null}
              {ticket.workflowState ? (
                <span style={workflowBadgeStyle}>{ticket.workflowState}</span>
              ) : null}
            </div>
            <h1
              className="t-h1"
              style={{
                marginTop: 10,
                fontSize: 'clamp(24px, 3.6vw, 34px)',
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
              }}
            >
              {ticket.title}
            </h1>
          </div>
          <div style={{ flexShrink: 0, display: 'flex', gap: 10, alignItems: 'center' }}>
            <TicketDeleteButton ticketId={ticket.id} title={ticket.title} />
            <Link
              href="/tickets"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--ink-3)',
                textDecoration: 'none',
                letterSpacing: '0.02em',
              }}
            >
              ← Alle Tickets
            </Link>
          </div>
        </div>

        <div style={{ marginTop: 20 }}>
          <WorkflowPipeline
            ticketId={ticket.id}
            state={toWorkflowState(ticket.workflowState)}
            accentVar={accentVarForAccent(workspace?.accent ?? 'own')}
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <TicketActions ticketId={ticket.id} currentStatus={ticket.status} />
        </div>

        {ticket.sessionRefs && ticket.sessionRefs.length > 0 ? (
          <TicketSessionRefs
            sessionRefs={ticket.sessionRefs}
            workspaceId={ticket.segmentId}
          />
        ) : null}

        <div style={layoutStyle}>
          <div style={{ display: 'grid', gap: 24, minWidth: 0 }}>
            <section>
              <SectionHeader>Beschreibung</SectionHeader>
              <TicketBody body={ticket.body} />
            </section>

            <TicketDetailTabs
              ticketId={ticket.id}
              timelineCount={timeline.length}
              workProductsCount={workProducts.length}
              commentCount={timeline.filter((e) => e.eventType === 'commented').length}
              threadSlot={<TicketThread events={timeline} />}
              replySlot={<TicketReplyBox ticketId={ticket.id} />}
              timelineSlot={<TicketTimeline events={timeline} />}
              workProducts={workProducts}
            />
          </div>

          <aside style={asideStyle}>
            <SectionHeader>Meta</SectionHeader>
            <dl style={{ margin: 0, display: 'grid', gap: 10, marginTop: 10 }}>
              <MetaRow label="Workspace">
                <Pill variant={pillVariant}>{workspaceLabel}</Pill>
              </MetaRow>
              {ticket.workstreamId ? (
                <MetaRow label="Workstream">
                  <Link
                    href={`/workstreams/${encodeURIComponent(ticket.workstreamId)}`}
                    style={workstreamPillStyle}
                  >
                    <IconWorkstreams size={12} />
                    {ticket.workstreamId}
                  </Link>
                </MetaRow>
              ) : null}
              {ticket.parentTicketId ? (
                <MetaRow label="Parent">
                  <Link
                    href={`/tickets/${encodeURIComponent(ticket.parentTicketId)}`}
                    style={codeStyle}
                  >
                    ↑ {ticket.parentTicketId}
                  </Link>
                </MetaRow>
              ) : null}
              <MetaRow label="ID">
                <code style={codeStyle}>{ticket.id}</code>
              </MetaRow>
              {ticket.assignee ? (
                <MetaRow label="Zuständig">{ticket.assignee}</MetaRow>
              ) : null}
              {ticket.due ? (
                <MetaRow label="Fällig">{ticket.due}</MetaRow>
              ) : null}
              {ticket.tags.length > 0 ? (
                <MetaRow label="Tags">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ticket.tags.map((tag) => (
                      <span key={tag} style={tagStyle}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </MetaRow>
              ) : null}
              <MetaRow label="Erstellt">{formatDate(ticket.createdAt)}</MetaRow>
              <MetaRow label="Geändert">{formatDate(ticket.updatedAt)}</MetaRow>
              {ticket.closedAt ? (
                <MetaRow label="Geschlossen">
                  {formatDate(ticket.closedAt)}
                </MetaRow>
              ) : null}
            </dl>
          </aside>
        </div>
      </section>
    </main>
  );
}

function StatusBadge({ status }: { status: TicketStatus }) {
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
        fontSize: 11,
        padding: '3px 10px',
        borderRadius: 6,
        color,
        border: `0.5px solid ${color}`,
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </span>
  );
}

function PrioBadge({ prio }: { prio: string }) {
  const color = prio.startsWith('P0')
    ? 'var(--a-danger)'
    : prio.startsWith('P1')
      ? 'var(--a-now)'
      : 'var(--ink-2)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        padding: '3px 8px',
        borderRadius: 6,
        color,
        border: `0.5px solid ${color}`,
        letterSpacing: '0.04em',
      }}
    >
      {prio}
    </span>
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

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 10, alignItems: 'center' }}>
      <dt
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--ink-3)',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, fontSize: 13, color: 'var(--ink)' }}>{children}</dd>
    </div>
  );
}

function pillVariantForAccent(
  accent: 'own' | 'clientb' | 'north' | 'private',
): PillVariant {
  return accent;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

/**
 * Layout uses CSS Grid `auto-fit` + `minmax(min(100%, 480px), 1fr)` —
 * above ~720px: two-column (main + aside); below: wraps to single
 * column naturally, no media query needed. iPhone 14 Pro (390px) →
 * single column, aside becomes a block below Timeline.
 */
const layoutStyle: CSSProperties = {
  marginTop: 28,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
  gap: 24,
  minWidth: 0,
  // overflow-hidden 2026-04-26: long Markdown code blocks or stack traces
  // in comments were breaking the container on mobile. minWidth 0 + overflow-hidden
  // forces grid children to stay within the container; scrolling then happens
  // INSIDE the code block.
  overflowX: 'hidden',
};

const asideStyle: CSSProperties = {
  padding: '18px 18px',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  alignSelf: 'start',
  maxWidth: '100%',
  minWidth: 0,
};

const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  background: 'var(--sheet-3)',
  padding: '2px 6px',
  borderRadius: 4,
  wordBreak: 'break-all',
};

const tagStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '2px 6px',
  borderRadius: 4,
  color: 'var(--ink-2)',
  background: 'var(--sheet-3)',
  border: '0.5px solid var(--line-2)',
};

const workstreamPillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '2px 8px',
  borderRadius: 999,
  color: 'var(--a-now)',
  background: 'color-mix(in oklab, var(--a-now) 12%, transparent)',
  border: '0.5px solid var(--a-now)',
  textDecoration: 'none',
  letterSpacing: '0.02em',
};

const workflowBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  padding: '2px 6px',
  borderRadius: 4,
  color: 'var(--ink-2)',
  background: 'var(--sheet-3)',
  border: '0.5px solid var(--line-2)',
  letterSpacing: '0.04em',
};

function toWorkflowState(raw: string | undefined): WorkflowState {
  if (
    raw === 'draft' ||
    raw === 'review' ||
    raw === 'approved' ||
    raw === 'executed' ||
    raw === 'closed' ||
    raw === 'rejected'
  ) {
    return raw;
  }
  return 'draft';
}

function accentVarForAccent(
  accent: 'own' | 'clientb' | 'north' | 'private',
): string {
  switch (accent) {
    case 'clientb':
      return 'a-clientb';
    case 'north':
      return 'a-north';
    case 'private':
      return 'a-private';
    case 'own':
    default:
      return 'a-own';
  }
}
