/**
 * POST /api/workstreams/[id]/restart
 *
 * Recovery affordance (2026-05-25) — lightweight endpoint that, after a
 * recovery sweep, sets a stuck workstream going again.
 *
 * Delegates directly to the existing resume logic (tier-orchestrator →
 * runIterateResume). The difference from /resume: this endpoint is explicitly
 * meant for the recovery flow and accepts ONLY status='stuck'. It is the
 * action endpoint that the deep link in the recovery status card targets.
 *
 * Security: requireAuth + canEditWorkspaceContent (identical to /resume).
 *
 * NOT destructive: re-sets up the run, deletes NO data.
 * NEVER blindly auto-spawn without user action — this endpoint is called ONLY by
 * explicit user action (click / re-prompt), NOT automatically
 * by the recovery sweep (which only marks stuck and notifies, R3-safe).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { writeDecision } from '@/lib/workstreams/trace-repo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WsRow {
  workspace_id: string;
  status: string;
  name: string;
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
      'SELECT workspace_id, status, name, primary_ticket_id FROM workstreams WHERE id = ?',
    )
    .get(workstreamId) as WsRow | undefined;

  if (!ws) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspace_id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Restart only makes sense for stuck. Early diagnostic response on an
  // obviously wrong state (active/paused) — better error message.
  // The actual race protection, however, is the atomic claim UPDATE below,
  // NOT this SELECT check (Critic-Fix #3).
  if (ws.status !== 'stuck') {
    return NextResponse.json(
      {
        error: 'invalid-state',
        hint:
          `Restart ist nur für status='stuck' verfügbar (Recovery-Affordanz). ` +
          `Aktuell: '${ws.status}'. Für active/paused → POST /resume verwenden.`,
        currentStatus: ws.status,
      },
      { status: 409 },
    );
  }

  // Critic-Fix #3 — double-spawn race: optimistic claim UPDATE.
  // Two fast clicks → two parallel requests. Both read status='stuck'
  // above and would both spawn. Solution: the transition
  // stuck→active is the atomic claim. Only the request that actually
  // changes the row (changes>0) may spawn. The second gets
  // changes===0 → 409, NO second spawn.
  const now = Date.now();
  const claim = db.$raw
    .prepare(
      `UPDATE workstreams
          SET status = 'active', updated_at = ?
        WHERE id = ? AND status = 'stuck'`,
    )
    .run(now, workstreamId);

  if ((claim as { changes?: number }).changes === 0) {
    // Another request was faster (or the status changed between
    // SELECT and UPDATE). No spawn — the winning request is running.
    return NextResponse.json(
      {
        error: 'already-claimed',
        hint:
          'Restart läuft bereits (anderer Request war schneller) oder der ' +
          'Status ist nicht mehr stuck. Kein zweiter Spawn ausgelöst.',
      },
      { status: 409 },
    );
  }

  if (!ws.primary_ticket_id) {
    // Claim successful (status is now 'active'), but without a master ticket
    // runIterateResume cannot spawn. Status stays 'active' so the
    // user can continue manually via a chat prompt.
    writeDecision({
      workspaceId: ws.workspace_id,
      workstreamId,
      coordKey: `${ws.workspace_id}/${workstreamId}`,
      decisionKind: 'fail_closed_recovery',
      rationale:
        `User-initiierter Restart via /restart (kein primary_ticket_id). ` +
        `Status auf 'active' geclaimt — User kann per Chat-Prompt fortsetzen.`,
      actor: 'user',
    });

    return NextResponse.json({
      ok: true,
      restarted: false,
      reason: 'no-master-ticket-status-reset-to-active',
      hint: 'Kein Master-Ticket — Status auf active gesetzt. Fortsetzen per Chat-Prompt.',
    });
  }

  // N8: trace before the spawn.
  writeDecision({
    workspaceId: ws.workspace_id,
    workstreamId,
    coordKey: `${ws.workspace_id}/${workstreamId}`,
    decisionKind: 'fail_closed_recovery',
    rationale:
      `User-initiierter Restart via /restart nach Recovery-Sweep (Claim gewonnen). ` +
      `runIterateResume wird gestartet (neue Welle V_{n+1}).`,
    actor: 'user',
  });

  // Delegate to the existing resume logic. The run is already claimed 'active',
  // a parallel restart can no longer get through.
  try {
    const { runIterateResume } = await import('@/server/agents/tier-orchestrator');
    const result = await runIterateResume(workstreamId);
    return NextResponse.json({ ok: true, restarted: true, ...result });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'restart-failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
