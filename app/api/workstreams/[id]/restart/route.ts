/**
 * POST /api/workstreams/[id]/restart
 *
 * Recovery-Affordanz (2026-05-25) — leichtgewichtiger Endpunkt der nach einem
 * Recovery-Sweep einen stuck Workstream wieder in Gang setzt.
 *
 * Delegiert direkt an die bestehende Resume-Logik (tier-orchestrator →
 * runIterateResume). Der Unterschied zu /resume: dieser Endpunkt ist explizit
 * für den Recovery-Flow gedacht und akzeptiert NUR status='stuck'. Er ist der
 * Aktions-Endpunkt den der Deep-Link in der Recovery-Status-Card anspricht.
 *
 * Sicherheit: requireAuth + canEditWorkspaceContent (identisch zu /resume).
 *
 * NICHT destruktiv: setzt den Run neu auf, löscht KEINE Daten.
 * NIE blind auto-spawn ohne User-Aktion — dieser Endpunkt wird NUR durch
 * explizite User-Aktion (Click / Re-Prompt) aufgerufen, NICHT automatisch
 * vom Recovery-Sweep (der stuck-markt und notifiziert nur, R3-sicher).
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

  // Restart ist nur für stuck sinnvoll. Frühe Diagnose-Antwort bei
  // offensichtlich falschem State (active/paused) — bessere Fehlermeldung.
  // Der eigentliche Race-Schutz ist aber das atomare Claim-UPDATE unten,
  // NICHT diese SELECT-Prüfung (Critic-Fix #3).
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

  // Critic-Fix #3 — Doppel-Spawn-Race: optimistisches Claim-UPDATE.
  // Zwei schnelle Klicks → zwei parallele Requests. Beide haben oben
  // status='stuck' gelesen, würden beide spawnen. Lösung: der Übergang
  // stuck→active ist der atomare Claim. Nur der Request der die Row
  // tatsächlich verändert (changes>0) darf spawnen. Der zweite bekommt
  // changes===0 → 409, KEIN zweiter Spawn.
  const now = Date.now();
  const claim = db.$raw
    .prepare(
      `UPDATE workstreams
          SET status = 'active', updated_at = ?
        WHERE id = ? AND status = 'stuck'`,
    )
    .run(now, workstreamId);

  if ((claim as { changes?: number }).changes === 0) {
    // Ein anderer Request war schneller (oder der Status hat sich zwischen
    // SELECT und UPDATE geändert). Kein Spawn — der Gewinner-Request läuft.
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
    // Claim erfolgreich (status ist jetzt 'active'), aber ohne Master-Ticket
    // kann runIterateResume nicht spawnen. Status bleibt 'active' damit der
    // User manuell per Chat-Prompt fortsetzen kann.
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

  // N8: Trace vor dem Spawn.
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

  // Delegate an bestehende Resume-Logik. Der Run ist bereits 'active' geclaimt,
  // ein paralleler Restart kann nicht mehr durchkommen.
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
