/**
 * POST /api/workstreams/[id]/cross-roast — Phase RA Trigger (2026-04-29).
 *
 * Manual trigger of the cross-roast phase of a workstream. Collects the
 * V_final sub-plan outputs from the sub-tickets, calls `runSubPlanSniper`
 * for missing sub-plans and then `runCrossRoast` with all V_finals.
 *
 * Body:
 *   {
 *     subTicketIds?: string[]   // Optional. If missing → all sub-tickets
 *                                // of the workstream are collected.
 *     skipSubPlans?: boolean    // If true: read V_final from existing
 *                                // sub-plan-v_final events, no
 *                                // re-spawn.
 *   }
 *
 * Auth: cookie session OR Bearer (LAZYOS_CHAT_KEY) for the CLI.
 *
 * Currently opt-in / manual. Phase IN-Implement after the OSS launch moves
 * the trigger into auto-dispatch-spawner.ts.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { defaultWorkspacePath } from '@/lib/workspaces/projects-root';
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { emitEvent } from '@/lib/events/emit';
import {
  runSubPlanSniper,
  runCrossRoast,
} from '@/server/agents/tier-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WorkstreamRow {
  workspace_id: string;
  primary_ticket_id: string | null;
  status: string;
}

interface TicketRow {
  id: string;
  title: string;
  body: string;
  parent_ticket_id: string | null;
}

async function authOk(req: NextRequest): Promise<{ userId: string } | null> {
  const userId = currentUserIdResolved(req);
  if (userId) return { userId };
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m) {
    const expected = (process.env.LAZYOS_CHAT_KEY ?? '').trim();
    if (expected.length > 0 && m[1] === expected) {
      return { userId: '@system' };
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: workstreamId } = await params;

  const auth = await authOk(req);
  if (!auth) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const db = getDb();
  const ws = db.$raw
    .prepare(
      'SELECT workspace_id, primary_ticket_id, status FROM workstreams WHERE id = ?',
    )
    .get(workstreamId) as WorkstreamRow | undefined;
  if (!ws) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  if (auth.userId !== '@system') {
    if (!canReadWorkspace(getEffectiveWorkspaceRole(auth.userId, ws.workspace_id))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  }
  if (!ws.primary_ticket_id) {
    return NextResponse.json(
      { error: 'no-master-ticket' },
      { status: 400 },
    );
  }

  let body: { subTicketIds?: unknown; skipSubPlans?: unknown };
  try {
    body = (await req.json().catch(() => ({}))) as {
      subTicketIds?: unknown;
      skipSubPlans?: unknown;
    };
  } catch {
    body = {};
  }
  const explicitIds = Array.isArray(body.subTicketIds)
    ? body.subTicketIds.filter((x): x is string => typeof x === 'string')
    : null;
  const skipSubPlans = body.skipSubPlans === true;

  // Determine sub-tickets
  const subRows = (
    explicitIds
      ? db.$raw
          .prepare(
            `SELECT id, title, body, parent_ticket_id FROM tickets
              WHERE id IN (${explicitIds.map(() => '?').join(',')})`,
          )
          .all(...explicitIds)
      : db.$raw
          .prepare(
            `SELECT id, title, body, parent_ticket_id FROM tickets
              WHERE parent_ticket_id = ?`,
          )
          .all(ws.primary_ticket_id)
  ) as TicketRow[];

  if (subRows.length === 0) {
    return NextResponse.json(
      { error: 'no-sub-tickets', hint: 'Master-Ticket hat noch keine Sub-Tickets.' },
      { status: 400 },
    );
  }

  // Read the master plan text from the last iterate-version (highest version)
  const masterRow = db.$raw
    .prepare(
      `SELECT payload FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'
        ORDER BY json_extract(payload,'$.version') DESC, created_at DESC
        LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as { payload: string } | undefined;
  const masterPlanText = masterRow
    ? (JSON.parse(masterRow.payload).text as string)
    : '(Master-Plan-Text nicht gefunden — Iterate möglicherweise nicht gelaufen.)';

  // Workspace path for tmux
  const wsRow = db.$raw
    .prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(ws.workspace_id) as { path: string | null } | undefined;
  const workspacePath = wsRow?.path?.trim() || defaultWorkspacePath(ws.workspace_id);

  // Run the subplan sniper for each sub (or skip it)
  const subPlans: Array<{ subTicketId: string; subBrief: string; finalText: string }> = [];

  for (const sub of subRows) {
    let finalText: string;
    if (skipSubPlans) {
      const finalRow = db.$raw
        .prepare(
          `SELECT payload FROM events
            WHERE entity_type='ticket' AND entity_id=?
              AND event_type='commented'
              AND json_extract(payload,'$.kind')='sub-plan-v_final'
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(sub.id) as { payload: string } | undefined;
      finalText = finalRow
        ? (JSON.parse(finalRow.payload).text as string)
        : `(kein V_final für Sub ${sub.id} gefunden.)`;
    } else {
      try {
        const sub_result = await runSubPlanSniper({
          workspaceId: ws.workspace_id,
          workspacePath,
          workstreamId,
          subTicketId: sub.id,
          masterPlanText,
          subTicketBrief: `${sub.title}\n\n${sub.body ?? ''}`,
        });
        finalText = sub_result.finalText;
      } catch (err) {
        finalText = `(SubPlanSniper für ${sub.id} fehlgeschlagen: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
    subPlans.push({
      subTicketId: sub.id,
      subBrief: sub.title,
      finalText,
    });
  }

  // Cross-roast over all V_final
  let crossResult;
  try {
    crossResult = await runCrossRoast({
      workspaceId: ws.workspace_id,
      workspacePath,
      workstreamId,
      masterTicketId: ws.primary_ticket_id,
      masterPlanText,
      subPlans,
    });
  } catch (err) {
    await emitEvent({
      segmentId: ws.workspace_id,
      entityType: 'ticket',
      entityId: ws.primary_ticket_id ?? workstreamId,
      eventType: 'commented',
      actor: 'agent:cross-roast-lead',
      payload: {
        kind: 'cross-roast-failed',
        workstreamId,
        error: err instanceof Error ? err.message : String(err),
      },
      sensitivity: 'low',
    }).catch(() => undefined);
    return NextResponse.json(
      {
        error: 'cross-roast-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    workstreamId,
    masterTicketId: ws.primary_ticket_id,
    subTicketsProcessed: subPlans.length,
    iterations: crossResult.iterations,
    totalCostCents: crossResult.totalCostCents,
    totalDurationMs: crossResult.totalDurationMs,
    finalText: crossResult.finalText,
  });
}
