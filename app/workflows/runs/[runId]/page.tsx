/**
 * /workflows/runs/[runId] — Run-Detail.
 *
 * Pattern 4 Welle 2.2 (2026-05-01).
 *
 * Server-Component. Zeigt:
 *   - Run-Status (workflow, version, currentState, status, timestamps)
 *   - History via events-Tabelle (workflow.* events, desc-sort)
 *   - Manual-Override-Buttons wenn currentState.manualOverride='allow'
 *   - Link auf Workflow-Detail
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { CSSProperties } from 'react';

import { ContextBand } from '@/lib/ui/cbd';
import { loadRun } from '@/lib/workflows/store';
import { getWorkflow } from '@/lib/workflows/registry';
import { findState } from '@/lib/workflows/dsl';
import { getDb } from '@/db/client';
import { events as eventsTable } from '@/db/schema/events';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { currentUserIdResolved } from '@/lib/security/subject-server';

import { ManualOverrideControls } from '../../_components/ManualOverrideControls';

export const dynamic = 'force-dynamic';

const WORKFLOW_EVENT_TYPES = [
  'workflow.started',
  'workflow.transitioned',
  'workflow.stuck',
  'workflow.completed',
] as const;

interface HistoryRow {
  id: string;
  createdAt: number;
  eventType: string;
  actor: string;
  payload: string;
}

export default async function RunDetailPage(props: {
  params: Promise<{ runId: string }>;
}): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) redirect('/login?reason=workflow-run-needs-login');

  const { runId } = await props.params;
  const run = await loadRun(runId);
  if (!run) notFound();

  const def = getWorkflow(run.workflowId, run.definitionVersion);
  const stateNode = def ? findState(def, run.currentState) : null;

  const db = getDb();
  const eventRows = (await db
    .select({
      id: eventsTable.id,
      createdAt: eventsTable.createdAt,
      eventType: eventsTable.eventType,
      actor: eventsTable.actor,
      payload: eventsTable.payload,
    })
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.entityType, 'workflow_run'),
        eq(eventsTable.entityId, run.id),
        inArray(eventsTable.eventType, WORKFLOW_EVENT_TYPES as readonly string[] as string[]),
      ),
    )
    .orderBy(desc(eventsTable.createdAt))
    .limit(200)) as ReadonlyArray<HistoryRow>;

  const overrideAllowed =
    stateNode?.manualOverride === 'allow' &&
    (run.status === 'running' || run.status === 'stuck');

  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={{ maxWidth: 980, margin: '0 auto' }}>
        <ContextBand
          pillLabel={def?.label ?? run.workflowId}
          breadcrumb={`Run ${run.id} · ${run.definitionVersion}`}
        />

        <h1 style={titleStyle}>
          {def?.label ?? run.workflowId}
          <span style={runIdSubtitleStyle}>{run.id}</span>
        </h1>
        <p style={leadStyle}>
          {def?.description ?? '— keine Definition gefunden —'}
        </p>

        <Link href={`/workflows/${encodeURIComponent(run.workflowId)}`} style={backLinkStyle}>
          ← zur Definition
        </Link>

        <section style={cardStyle} className="srf-pop">
          <div style={statusGridStyle}>
            <Stat label="Status" value={run.status} accent={run.status} />
            <Stat label="Aktueller State" value={stateNode?.label ?? run.currentState} />
            <Stat label="LLM-Slot" value={stateNode?.llmSlot ?? '—'} />
            <Stat
              label="Override"
              value={stateNode?.manualOverride ?? '—'}
            />
          </div>

          <div style={timelineStyle}>
            <TimelineEntry
              label="Erstellt"
              ts={run.createdAt}
            />
            <TimelineEntry
              label="Letzter Wechsel"
              ts={run.lastTransitionAt}
            />
            <TimelineEntry
              label="Updated"
              ts={run.updatedAt}
            />
          </div>
        </section>

        {overrideAllowed && stateNode && def ? (
          <section style={sectionStyle}>
            <h2 style={sectionTitleStyle}>Manual Override</h2>
            <p style={sectionLeadStyle}>
              Aktueller State erlaubt manuelles Weiterschalten ohne post-
              Conditions zu erfüllen. Nur bei eindeutigen Out-of-Band-Wechseln
              nutzen — die History markiert den forced-Flag.
            </p>
            <ManualOverrideControls
              runId={run.id}
              transitions={stateNode.transitions.map((t) => ({
                to: t.to,
                label: t.label,
              }))}
            />
          </section>
        ) : null}

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>
            History <span style={countStyle}>({eventRows.length})</span>
          </h2>
          {eventRows.length === 0 ? (
            <div style={emptyStyle}>Noch keine Events. Run wurde gerade gestartet?</div>
          ) : (
            <ol style={historyListStyle}>
              {eventRows.map((row) => {
                let payload: Record<string, unknown> = {};
                try {
                  const obj = JSON.parse(row.payload) as unknown;
                  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    payload = obj as Record<string, unknown>;
                  }
                } catch {
                  // ignore
                }
                return (
                  <li key={row.id} style={historyItemStyle}>
                    <header style={historyHeaderStyle}>
                      <span style={historyTypeStyle(row.eventType)}>
                        {row.eventType.replace('workflow.', '')}
                      </span>
                      <span style={historyActorStyle}>{row.actor}</span>
                      <time
                        dateTime={new Date(row.createdAt).toISOString()}
                        style={historyTimeStyle}
                      >
                        {new Date(row.createdAt).toLocaleString('de-DE')}
                      </time>
                    </header>
                    <pre style={historyPayloadStyle}>
                      {JSON.stringify(payload, null, 2)}
                    </pre>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Daten</h2>
          <pre style={dataStyle}>{JSON.stringify(run.data, null, 2)}</pre>
        </section>
      </section>
    </main>
  );
}

interface StatProps {
  label: string;
  value: string;
  accent?: string;
}

function Stat(props: StatProps): React.JSX.Element {
  const accentColor =
    props.accent === 'stuck'
      ? 'var(--a-warn, #c08)'
      : props.accent === 'completed'
        ? 'var(--a-now)'
        : props.accent === 'running'
          ? 'var(--a-now)'
          : 'var(--ink)';
  return (
    <div style={statStyle}>
      <dt style={statLabelStyle}>{props.label}</dt>
      <dd style={{ ...statValueStyle, color: accentColor }}>{props.value}</dd>
    </div>
  );
}

interface TimelineEntryProps {
  label: string;
  ts: number;
}

function TimelineEntry(props: TimelineEntryProps): React.JSX.Element {
  return (
    <div style={timelineEntryStyle}>
      <span style={timelineLabelStyle}>{props.label}</span>
      <time dateTime={new Date(props.ts).toISOString()} style={timelineValueStyle}>
        {new Date(props.ts).toLocaleString('de-DE')}
      </time>
    </div>
  );
}

// --------------------------------------------------------------------------
// Styles
// --------------------------------------------------------------------------

const titleStyle: CSSProperties = {
  marginTop: 22,
  fontSize: 'clamp(26px, 3.6vw, 36px)',
  letterSpacing: '-0.02em',
  fontWeight: 600,
  color: 'var(--ink)',
  display: 'flex',
  alignItems: 'baseline',
  gap: 12,
  flexWrap: 'wrap',
};

const runIdSubtitleStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
  fontWeight: 400,
};

const leadStyle: CSSProperties = {
  color: 'var(--ink-2)',
  marginTop: 8,
  lineHeight: 1.55,
  fontSize: 14,
  maxWidth: 680,
};

const backLinkStyle: CSSProperties = {
  display: 'inline-flex',
  marginTop: 12,
  fontSize: 12,
  color: 'var(--ink-3)',
  textDecoration: 'none',
};

const cardStyle: CSSProperties = {
  marginTop: 28,
  padding: 22,
  borderRadius: 'var(--radius-lg, 16px)',
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
};

const statusGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: 14,
  margin: 0,
};

const statStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const statLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  margin: 0,
};

const statValueStyle: CSSProperties = {
  fontSize: 16,
  fontWeight: 500,
  margin: 0,
  fontVariantNumeric: 'tabular-nums',
};

const timelineStyle: CSSProperties = {
  display: 'flex',
  gap: 16,
  flexWrap: 'wrap',
  paddingTop: 14,
  borderTop: '0.5px solid var(--line-2)',
};

const timelineEntryStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const timelineLabelStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--ink-3)',
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

const timelineValueStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-2)',
};

const sectionStyle: CSSProperties = {
  marginTop: 36,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  margin: 0,
};

const sectionLeadStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-3)',
  margin: 0,
  lineHeight: 1.55,
};

const countStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
  marginLeft: 6,
};

const emptyStyle: CSSProperties = {
  padding: 22,
  textAlign: 'center',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 12,
  color: 'var(--ink-3)',
  fontSize: 13,
};

const historyListStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const historyItemStyle: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 'var(--radius-md, 10px)',
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const historyHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
};

function historyTypeStyle(eventType: string): CSSProperties {
  const color =
    eventType === 'workflow.stuck'
      ? 'var(--a-warn, #c08)'
      : eventType === 'workflow.completed'
        ? 'var(--a-now)'
        : 'var(--ink-2)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    border: `0.5px solid ${color}`,
    color,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
  };
}

const historyActorStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
};

const historyTimeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  marginLeft: 'auto',
};

const historyPayloadStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  background: 'var(--sheet-3, var(--sheet-2))',
  padding: 10,
  borderRadius: 6,
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 240,
  overflow: 'auto',
};

const dataStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-2)',
  background: 'var(--sheet-2)',
  border: '0.5px solid var(--line-2)',
  padding: 14,
  borderRadius: 'var(--radius-md, 10px)',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
