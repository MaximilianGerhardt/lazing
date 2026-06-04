/**
 * /workflows — Pattern 4 Welle 2.2 Landing.
 *
 * List of all WorkflowDefinitions as cards. Active-run counts via direct
 * DB aggregation per workflow ID. Server component.
 */

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { CSSProperties } from 'react';

import { ContextBand } from '@/lib/ui/cbd';
import { WORKFLOW_REGISTRY } from '@/lib/workflows/registry';
import { getDb } from '@/db/client';
import { workflowRuns } from '@/db/schema/workflow_runs';
import { eq, sql } from 'drizzle-orm';
import { currentUserIdResolved } from '@/lib/security/subject-server';

import { WorkflowCard } from './_components/WorkflowCard';

export const dynamic = 'force-dynamic';

interface RunCountRow {
  workflowId: string;
  cnt: number;
}

async function loadActiveRunCounts(): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db
    .select({
      workflowId: workflowRuns.workflowId,
      cnt: sql<number>`count(*)`,
    })
    .from(workflowRuns)
    .where(eq(workflowRuns.status, 'running'))
    .groupBy(workflowRuns.workflowId);
  const map = new Map<string, number>();
  for (const r of rows as ReadonlyArray<RunCountRow>) {
    map.set(r.workflowId, Number(r.cnt) || 0);
  }
  return map;
}

export default async function WorkflowsLandingPage(): Promise<React.JSX.Element> {
  const h = await headers();
  const userId = currentUserIdResolved({ headers: h });
  if (!userId) redirect('/login?reason=workflows-needs-login');

  const definitions = Object.values(WORKFLOW_REGISTRY);
  const activeCounts = await loadActiveRunCounts();

  // Fully implemented workflows first, stubs afterwards.
  const sorted = [...definitions].sort((a, b) => {
    const aStub = a.states.length === 1 && a.states[0]?.id === 'noop';
    const bStub = b.states.length === 1 && b.states[0]?.id === 'noop';
    if (aStub === bStub) return a.label.localeCompare(b.label);
    return aStub ? 1 : -1;
  });

  return (
    <main className="sheet" style={{ paddingBottom: 80 }}>
      <section style={{ maxWidth: 1100, margin: '0 auto' }}>
        <ContextBand
          pillLabel="Workflows"
          breadcrumb={`${definitions.length} Definitionen`}
        />

        <h1 style={titleStyle}>Workflows</h1>
        <p style={leadStyle}>
          Kodifizierte Domain-Workflows als deterministische Schritte. LLM
          nur dort, wo unstrukturierte Inferenz nötig ist — der Rest läuft
          als FSM mit pre/post-Conditions. Pattern 4 (2026-05-01) adressiert
          Critic-VETO-3 und macht die Methodik prüfbar statt Markdown-
          Prompt-Wall.
        </p>

        <ul style={gridStyle}>
          {sorted.map((def) => {
            const isStub = def.states.length === 1 && def.states[0]?.id === 'noop';
            return (
              <li key={def.id} style={liStyle}>
                <WorkflowCard
                  workflowId={def.id}
                  label={def.label}
                  description={def.description}
                  version={def.version}
                  stateCount={def.states.length}
                  triggerHints={def.triggerHints}
                  isStub={isStub}
                  deprecated={def.deprecated ?? false}
                  activeRunCount={activeCounts.get(def.id) ?? 0}
                />
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}

const titleStyle: CSSProperties = {
  marginTop: 22,
  fontSize: 'clamp(28px, 4vw, 40px)',
  letterSpacing: '-0.02em',
  fontWeight: 600,
  color: 'var(--ink)',
};

const leadStyle: CSSProperties = {
  color: 'var(--ink-2)',
  maxWidth: 720,
  marginTop: 8,
  lineHeight: 1.55,
  fontSize: 14,
};

const gridStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  marginTop: 36,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: 16,
};

const liStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
};
