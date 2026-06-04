/**
 * POST /api/workstreams/[id]/cancel — Sub-Plan 01c (2026-04-29).
 *
 * User-Trigger: hängenden oder unerwünschten Workstream sauber als done
 * markieren mit Audit-Event „cancelled-by-user". KEIN Process-Kill — wenn
 * noch Spawns laufen, beenden sie sich selbst (events danach werden
 * weiterhin emittiert, sind aber nicht mehr „aktiv" UI-seitig).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { emitEvent } from '@/lib/events/emit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WsRow {
  workspace_id: string;
  status: string;
  primary_ticket_id: string | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: workstreamId } = await params;
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }
  const db = getDb();
  const ws = db.$raw
    .prepare(
      'SELECT workspace_id, status, primary_ticket_id FROM workstreams WHERE id = ?',
    )
    .get(workstreamId) as WsRow | undefined;
  if (!ws) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  if (
    !canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspace_id))
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (ws.status === 'done' || ws.status === 'archived') {
    return NextResponse.json({
      ok: true,
      already: ws.status,
      workstreamId,
    });
  }

  db.$raw
    .prepare("UPDATE workstreams SET status='done', updated_at=? WHERE id=?")
    .run(Date.now(), workstreamId);

  if (ws.primary_ticket_id) {
    await emitEvent({
      segmentId: ws.workspace_id,
      entityType: 'ticket',
      entityId: ws.primary_ticket_id,
      eventType: 'commented',
      actor: ('user:' + userId) as `user:${string}`,
      payload: {
        kind: 'workstream-cancelled',
        workstreamId,
        previousStatus: ws.status,
        reason: 'user-cancel',
      },
      sensitivity: 'low',
    }).catch(() => undefined);
  }

  return NextResponse.json({
    ok: true,
    workstreamId,
    previousStatus: ws.status,
    newStatus: 'done',
  });
}
