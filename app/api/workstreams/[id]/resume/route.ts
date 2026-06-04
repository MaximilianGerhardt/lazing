/**
 * POST /api/workstreams/[id]/resume — Sub-Plan 01c (2026-04-29).
 *
 * User-Trigger: hängenden Workstream nach Service-Restart wiederbeleben.
 * Spawnt eine Welle V_{n+1} (Lead + 2 Roaster + Pause). Wenn V5 oder
 * Konvergenz erreicht: status='done'. Sonst bleibt active mit Pause —
 * User kann erneut Resume bei Tod.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';

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
  if (!ws.primary_ticket_id) {
    return NextResponse.json(
      { error: 'no-master-ticket' },
      { status: 400 },
    );
  }
  if (ws.status !== 'stuck' && ws.status !== 'active') {
    return NextResponse.json(
      {
        error: 'invalid-state',
        hint:
          'Resume nur möglich für status=stuck oder active. Aktuell: ' +
          ws.status,
      },
      { status: 409 },
    );
  }

  // Resume async im Hintergrund — Endpoint kehrt sofort zurück.
  // Caller bekommt 202 + ein „resumed-fromVersion"-Event-Marker.
  let initialAck;
  try {
    const { runIterateResume } = await import(
      '@/server/agents/tier-orchestrator'
    );
    // Fire-and-Track: das await wartet eine ganze Welle (~1-3 min).
    // UI pollt den Status via /api/workstreams/[id]/pause-status.
    initialAck = runIterateResume(workstreamId);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'resume-init-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  // Awaite — gibt Frontend einen klaren „one wave done"-Marker
  try {
    const result = await initialAck;
    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'resume-wave-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
