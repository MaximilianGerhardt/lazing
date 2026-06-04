/**
 * /workstreams — list + kanban of all workstreams (multi-agent containers).
 *
 * Server component: loads initially via service. View toggle (list|kanban) via
 * searchParams.view. Kanban groups by status — thereby replacing the old
 * /lanes (which now redirects to /workstreams?view=kanban).
 */

import Link from 'next/link';
import type { CSSProperties } from 'react';

import { listWorkstreams } from '@/lib/workstreams/service';
import type { Workstream, WorkstreamStatus } from '@/lib/workstreams/service';
import { Pill, type PillVariant } from '@/lib/ui/pil';
import { listWorkspaces } from '@/lib/workspaces';
import { ContextBand } from '@/lib/ui/cbd';

export const dynamic = 'force-dynamic';

type ViewMode = 'list' | 'kanban';

const KANBAN_COLUMNS: Array<{ status: WorkstreamStatus; label: string }> = [
  { status: 'active', label: 'Aktiv' },
  { status: 'paused', label: 'Pausiert' },
  { status: 'done', label: 'Fertig' },
  { status: 'archived', label: 'Archiviert' },
];

export default async function WorkstreamsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  const view: ViewMode = sp.view === 'kanban' ? 'kanban' : 'list';

  const [workstreams, workspaces] = await Promise.all([
    listWorkstreams({ status: 'all', limit: 200 }),
    listWorkspaces().catch(() => []),
  ]);

  const wsLabel = (id: string): string =>
    workspaces.find((w) => w.id === id)?.label ?? id;
  const wsAccent = (id: string): PillVariant => {
    const a = workspaces.find((w) => w.id === id)?.accent ?? 'own';
    return a as PillVariant;
  };

  const totalCount = workstreams.length;
  const activeCount = workstreams.filter((w) => w.status === 'active').length;

  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={{ maxWidth: 1280 }}>
        <ContextBand
          pillLabel="Workstreams"
          breadcrumb={`${activeCount} aktiv · ${totalCount} gesamt`}
        />

        <div style={headerRowStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              className="t-h1"
              style={{
                marginTop: 22,
                fontSize: 'clamp(28px, 4vw, 40px)',
                letterSpacing: '-0.02em',
              }}
            >
              Workstreams
            </h1>
            <p
              style={{
                color: 'var(--ink-2)',
                maxWidth: 640,
                marginTop: 8,
                fontSize: 14,
              }}
            >
              Container für Multi-Agent-Pläne. Ein Workstream bündelt eine
              User-Anfrage mit Master-Plan-Ticket, Sub-Tickets und der Claude-
              Session, in der debattiert + synthetisiert wird.
            </p>
          </div>

          <ViewToggle current={view} />
        </div>

        {workstreams.length === 0 ? (
          <div style={emptyStyle}>
            Noch keine Workstreams. Sobald du im Chat etwas planst, erkennt
            das System die Tier-Wahl-Card und legt einen Workstream an.
          </div>
        ) : view === 'kanban' ? (
          <KanbanBoard
            workstreams={workstreams}
            wsLabel={wsLabel}
            wsAccent={wsAccent}
          />
        ) : (
          <ListView
            workstreams={workstreams}
            wsLabel={wsLabel}
            wsAccent={wsAccent}
          />
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// View toggle
// ---------------------------------------------------------------------------

function ViewToggle({ current }: { current: ViewMode }) {
  return (
    <div role="tablist" aria-label="Ansicht" style={toggleWrapStyle}>
      <Link
        href="/workstreams"
        role="tab"
        aria-selected={current === 'list'}
        style={toggleBtnStyle(current === 'list')}
      >
        Liste
      </Link>
      <Link
        href="/workstreams?view=kanban"
        role="tab"
        aria-selected={current === 'kanban'}
        style={toggleBtnStyle(current === 'kanban')}
      >
        Kanban
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ListView({
  workstreams,
  wsLabel,
  wsAccent,
}: {
  workstreams: readonly Workstream[];
  wsLabel: (id: string) => string;
  wsAccent: (id: string) => PillVariant;
}) {
  return (
    <ul style={listStyle}>
      {workstreams.map((ws) => (
        <li key={ws.id}>
          <Link
            href={`/workstreams/${encodeURIComponent(ws.id)}`}
            style={itemStyle}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={headerLineStyle}>
                <Pill variant={wsAccent(ws.workspaceId)}>
                  {wsLabel(ws.workspaceId)}
                </Pill>
                <span style={statusBadgeStyle(ws.status)}>{ws.status}</span>
                {ws.tierMix ? (
                  <span style={tierMixStyle}>
                    {ws.tierMix.opus}·{ws.tierMix.sonnet}·{ws.tierMix.haiku}
                  </span>
                ) : null}
              </div>
              <div style={titleStyle}>{ws.name}</div>
              {ws.description ? (
                <div style={descStyle}>{ws.description}</div>
              ) : null}
            </div>
            <div style={metaStyle}>
              <code style={idStyle}>{ws.id}</code>
              {ws.costCents > 0 ? (
                <span style={costStyle}>
                  ≈ €{(ws.costCents / 100).toFixed(2)}
                </span>
              ) : null}
              {ws.qualityScore !== null ? (
                <span style={qualityStyle}>
                  <svg
                    width={12}
                    height={12}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z" />
                  </svg>
                  {ws.qualityScore.toFixed(1)}
                </span>
              ) : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Kanban view
// ---------------------------------------------------------------------------

function KanbanBoard({
  workstreams,
  wsLabel,
  wsAccent,
}: {
  workstreams: readonly Workstream[];
  wsLabel: (id: string) => string;
  wsAccent: (id: string) => PillVariant;
}) {
  const byStatus = new Map<WorkstreamStatus, Workstream[]>();
  for (const w of workstreams) {
    const bucket = byStatus.get(w.status) ?? [];
    bucket.push(w);
    byStatus.set(w.status, bucket);
  }

  return (
    <div style={kanbanGridStyle} role="list" aria-label="Workstream-Spalten">
      {KANBAN_COLUMNS.map((col) => {
        const items = byStatus.get(col.status) ?? [];
        return (
          <div
            key={col.status}
            role="listitem"
            aria-label={`Spalte ${col.label}`}
            style={kanbanColumnStyle}
          >
            <header style={kanbanHeaderStyle}>
              <span style={kanbanLabelStyle}>{col.label}</span>
              <span style={kanbanCountStyle}>{items.length}</span>
            </header>

            {items.length === 0 ? (
              <div style={kanbanEmptyStyle}>—</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {items.map((ws) => (
                  <Link
                    key={ws.id}
                    href={`/workstreams/${encodeURIComponent(ws.id)}`}
                    style={kanbanCardStyle}
                  >
                    <div style={kanbanCardHeaderStyle}>
                      <Pill variant={wsAccent(ws.workspaceId)}>
                        {wsLabel(ws.workspaceId)}
                      </Pill>
                      {ws.tierMix ? (
                        <span style={tierMixStyle}>
                          {ws.tierMix.opus}·{ws.tierMix.sonnet}·
                          {ws.tierMix.haiku}
                        </span>
                      ) : null}
                    </div>
                    <div style={kanbanTitleStyle}>{ws.name}</div>
                    <div style={kanbanFooterStyle}>
                      <code style={idStyle}>{shortId(ws.id)}</code>
                      {ws.costCents > 0 ? (
                        <span style={costStyle}>
                          €{(ws.costCents / 100).toFixed(2)}
                        </span>
                      ) : null}
                      {ws.qualityScore !== null ? (
                        <span style={qualityStyle}>
                          <svg
                            width={12}
                            height={12}
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={1.6}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z" />
                          </svg>
                          {ws.qualityScore.toFixed(1)}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function shortId(id: string): string {
  return id.split('-').slice(0, 2).join('-');
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

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
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    border: `0.5px solid ${color}`,
    color,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
  };
}

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 16,
  flexWrap: 'wrap',
  justifyContent: 'space-between',
};

const toggleWrapStyle: CSSProperties = {
  marginTop: 28,
  display: 'inline-flex',
  borderRadius: 999,
  border: '0.5px solid var(--line-2)',
  padding: 4,
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
};

const toggleBtnStyle = (active: boolean): CSSProperties => ({
  padding: '6px 14px',
  borderRadius: 999,
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  textDecoration: 'none',
  color: active ? 'var(--ink)' : 'var(--ink-3)',
  background: active
    ? 'color-mix(in oklab, var(--a-now) 18%, transparent)'
    : 'transparent',
  transition: 'color 0.18s, background 0.18s',
});

const emptyStyle: CSSProperties = {
  marginTop: 32,
  padding: 32,
  textAlign: 'center',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 14,
  color: 'var(--ink-3)',
  fontSize: 14,
  background: 'color-mix(in oklab, var(--sheet-2) 40%, transparent)',
};

const listStyle: CSSProperties = {
  marginTop: 28,
  listStyle: 'none',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const itemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  padding: '14px 18px',
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet-2) 70%, transparent)',
  textDecoration: 'none',
  color: 'inherit',
  flexWrap: 'wrap',
};

const headerLineStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 6,
};

const tierMixStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '2px 7px',
  borderRadius: 4,
  background: 'color-mix(in oklab, var(--a-now) 12%, transparent)',
  color: 'var(--a-now)',
  letterSpacing: '0.04em',
};

const titleStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.01em',
};

const descStyle: CSSProperties = {
  marginTop: 4,
  fontSize: 13,
  color: 'var(--ink-3)',
};

const metaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 4,
  flexShrink: 0,
};

const idStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  background: 'var(--sheet-3)',
  padding: '2px 6px',
  borderRadius: 4,
};

const costStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
};

const qualityStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--a-warn)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

// Kanban-specific
const kanbanGridStyle: CSSProperties = {
  marginTop: 32,
  display: 'grid',
  gridAutoFlow: 'column',
  gridAutoColumns: 'minmax(260px, 1fr)',
  gap: 14,
  overflowX: 'auto',
  scrollSnapType: 'x mandatory',
  padding: '4px 0 24px',
  WebkitOverflowScrolling: 'touch',
};

const kanbanColumnStyle: CSSProperties = {
  minWidth: 260,
  scrollSnapAlign: 'start',
  padding: 14,
  borderRadius: 14,
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const kanbanHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingBottom: 10,
  borderBottom: '0.5px dashed var(--line-2)',
};

const kanbanLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--ink-2)',
};

const kanbanCountStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const kanbanEmptyStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 14,
  color: 'var(--ink-4)',
  textAlign: 'center',
  padding: '20px 0',
};

const kanbanCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 10,
  border: '0.5px solid var(--line-2)',
  background: 'color-mix(in oklab, var(--sheet) 60%, transparent)',
  textDecoration: 'none',
  color: 'inherit',
};

const kanbanCardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const kanbanTitleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--ink)',
  letterSpacing: '-0.005em',
  lineHeight: 1.4,
};

const kanbanFooterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  marginTop: 2,
};
