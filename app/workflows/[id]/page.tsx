/**
 * /workflows/[id] — Workflow-Detail.
 *
 * Pattern 4 Welle 2.2 (2026-05-01).
 *
 * Server-Component. Zeigt:
 *   - WorkflowDefinition (label, version, description, triggerHints)
 *   - FSM-Graph (SVG-Komponente, Client-only)
 *   - Aktive Runs (workflow_runs, status='running' oder 'stuck')
 *   - Start-Button (Client-Komponente, posted /api/workflows)
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { CSSProperties } from 'react';

import { ContextBand } from '@/lib/ui/cbd';
import { getWorkflow } from '@/lib/workflows/registry';
import { getDb } from '@/db/client';
import { workflowRuns } from '@/db/schema/workflow_runs';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import type { WorkflowId } from '@/lib/workflows/dsl';

import { FsmGraph } from '../_components/FsmGraph';
import { StartRunButton } from '../_components/StartRunButton';

export const dynamic = 'force-dynamic';

const VALID_IDS: ReadonlyArray<WorkflowId> = [
  'dev-sprint',
  'field-measurement',
  'legal-brief',
  'design-gate-flow',
  'legal-correspondence',
];

async function loadRecentRuns(workflowId: WorkflowId): Promise<
  ReadonlyArray<{
    id: string;
    currentState: string;
    status: string;
    createdAt: number;
    lastTransitionAt: number;
  }>
> {
  const db = getDb();
  const rows = await db
    .select({
      id: workflowRuns.id,
      currentState: workflowRuns.currentState,
      status: workflowRuns.status,
      createdAt: workflowRuns.createdAt,
      lastTransitionAt: workflowRuns.lastTransitionAt,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, workflowId),
        inArray(workflowRuns.status, ['running', 'stuck']),
      ),
    )
    .orderBy(desc(workflowRuns.lastTransitionAt))
    .limit(20);
  return rows;
}

export default async function WorkflowDetailPage(props: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) redirect('/login?reason=workflows-needs-login');

  const { id } = await props.params;
  if (!(VALID_IDS as readonly string[]).includes(id)) notFound();
  const def = getWorkflow(id as WorkflowId);
  if (!def) notFound();

  const isStub = def.states.length === 1 && def.states[0]?.id === 'noop';
  const recentRuns = await loadRecentRuns(id as WorkflowId);

  // FsmGraph braucht serializable States — leite die Function-Felder ab.
  const graphStates = def.states.map((s) => ({
    id: s.id,
    label: s.label,
    llmSlot: s.llmSlot,
    manualOverride: s.manualOverride,
    transitions: s.transitions.map((t) => ({
      to: t.to,
      label: t.label,
    })),
  }));

  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={{ maxWidth: 1100, margin: '0 auto' }}>
        <ContextBand
          pillLabel={def.label}
          breadcrumb={`${def.id}@${def.version} · ${def.states.length} States`}
        />

        <header style={headerStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={titleStyle}>{def.label}</h1>
            <p style={leadStyle}>{def.description}</p>
          </div>
          {!isStub ? (
            <StartRunButton workflowId={def.id} workflowLabel={def.label} />
          ) : (
            <span style={stubBadgeStyle}>Coming Soon</span>
          )}
        </header>

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>FSM-Graph</h2>
          <p style={sectionLeadStyle}>
            Knoten = States. Pfeile = Transitions. Strichelt = LLM-Slot mit
            fixiertem Prompt, durchgezogen mit AI-Glyph = freie Inferenz, ohne
            Markierung = deterministischer Code-Schritt.
          </p>
          <div style={graphWrapStyle}>
            <FsmGraph states={graphStates} initialState={def.initialState} />
          </div>
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>
            Aktive Runs <span style={countStyle}>({recentRuns.length})</span>
          </h2>
          {recentRuns.length === 0 ? (
            <div style={emptyStyle}>
              Aktuell kein laufender Run. Starte mit dem Button oben.
            </div>
          ) : (
            <ul style={listStyle}>
              {recentRuns.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/workflows/runs/${encodeURIComponent(r.id)}`}
                    style={runRowStyle}
                  >
                    <span style={runIdStyle}>{r.id}</span>
                    <span style={runStateStyle}>→ {r.currentState}</span>
                    <span style={runStatusStyle(r.status)}>{r.status}</span>
                    <time
                      dateTime={new Date(r.lastTransitionAt).toISOString()}
                      style={runTimeStyle}
                    >
                      {new Date(r.lastTransitionAt).toLocaleString('de-DE')}
                    </time>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section style={sectionStyle}>
          <h2 style={sectionTitleStyle}>Trigger-Hints</h2>
          <ul style={hintsStyle}>
            {def.triggerHints.map((h) => (
              <li key={h} style={hintPillStyle}>
                {h}
              </li>
            ))}
          </ul>
        </section>
      </section>
    </main>
  );
}

// --------------------------------------------------------------------------
// Styles
// --------------------------------------------------------------------------

const headerStyle: CSSProperties = {
  marginTop: 22,
  display: 'flex',
  alignItems: 'flex-start',
  gap: 16,
  flexWrap: 'wrap',
};

const titleStyle: CSSProperties = {
  fontSize: 'clamp(28px, 4vw, 40px)',
  letterSpacing: '-0.02em',
  fontWeight: 600,
  color: 'var(--ink)',
  margin: 0,
};

const leadStyle: CSSProperties = {
  color: 'var(--ink-2)',
  maxWidth: 720,
  marginTop: 8,
  lineHeight: 1.55,
  fontSize: 14,
};

const sectionStyle: CSSProperties = {
  marginTop: 40,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
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
  lineHeight: 1.55,
  margin: 0,
};

const stubBadgeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '6px 10px',
  borderRadius: 'var(--radius-md, 10px)',
  background: 'color-mix(in oklab, var(--ink-3) 14%, transparent)',
  color: 'var(--ink-3)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

const graphWrapStyle: CSSProperties = {
  padding: 16,
  borderRadius: 'var(--radius-lg, 16px)',
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  overflowX: 'auto',
};

const countStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-3)',
};

const emptyStyle: CSSProperties = {
  padding: 22,
  textAlign: 'center',
  border: '0.5px dashed var(--line-2)',
  borderRadius: 12,
  color: 'var(--ink-3)',
  fontSize: 13,
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const runRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 'var(--radius-md, 10px)',
  border: '0.5px solid var(--line-2)',
  background: 'var(--sheet-2)',
  textDecoration: 'none',
  color: 'var(--ink)',
};

const runIdStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--ink-2)',
  flex: '0 0 auto',
};

const runStateStyle: CSSProperties = {
  fontSize: 13,
  color: 'var(--ink)',
  fontWeight: 500,
  flex: '1 1 auto',
  minWidth: 0,
};

function runStatusStyle(status: string): CSSProperties {
  const color =
    status === 'stuck'
      ? 'var(--a-warn, #c08)'
      : status === 'running'
        ? 'var(--a-now)'
        : 'var(--ink-3)';
  return {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    padding: '2px 6px',
    borderRadius: 4,
    border: `0.5px solid ${color}`,
    color,
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    flex: '0 0 auto',
  };
}

const runTimeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--ink-3)',
  flex: '0 0 auto',
};

const hintsStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

const hintPillStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  padding: '4px 9px',
  borderRadius: 999,
  background: 'var(--sheet-3, var(--sheet-2))',
  color: 'var(--ink-2)',
};
