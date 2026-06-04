/**
 * GET /api/workstreams/[id]/pause-status
 *
 * Sniper-Live-Status. Liefert ob gerade ein Pause-Window läuft, wie lange
 * noch übrig ist, und nach welcher Phase es ist (roast / v2 / v3 / ...).
 *
 * Implementation: schaut auf das jüngste `sniper-pause-start`-Event am
 * Master-Ticket. Wenn `created_at + durationMs > now`, wird die Differenz
 * als `remainingMs` zurückgegeben — und die Existenz späterer
 * `iterate-version`-Events nach dem Pause-Start beweist, dass die Pause
 * eigentlich schon vorbei ist (Lead-Spawn lief weiter).
 *
 * Auth: User muss eingeloggt + viewer im Workspace sein.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface WorkstreamRow {
  workspace_id: string;
  primary_ticket_id: string | null;
  status: string;
}

interface PauseEventRow {
  created_at: number;
  payload: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: workstreamId } = await params;

  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const db = getDb();
  const ws = db.$raw
    .prepare(
      "SELECT workspace_id, primary_ticket_id, status FROM workstreams WHERE id = ?",
    )
    .get(workstreamId) as WorkstreamRow | undefined;
  if (!ws) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }
  if (!canReadWorkspace(getEffectiveWorkspaceRole(userId, ws.workspace_id))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!ws.primary_ticket_id || ws.status !== "active") {
    return NextResponse.json({
      isPaused: false,
      remainingMs: 0,
      after: null,
      workstreamStatus: ws.status,
    });
  }

  // Letztes pause-start ODER auto-dispatch-pause (Phase RA.4) — beide
  // bedeuten „User hat ein Inject-Window".
  const pauseRow = db.$raw
    .prepare(
      `SELECT created_at, payload FROM events
        WHERE entity_type = 'ticket'
          AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') IN ('sniper-pause-start', 'auto-dispatch-pause')
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as PauseEventRow | undefined;

  // Roast-Active-Hint: gibt es iterate-version v1 aber noch keinen
  // pause-start-Marker? Dann läuft gerade die Roast-Phase und der User
  // soll wissen "korrigieren ist legitim, landet in V2".
  let phase: 'idle' | 'lead-v1' | 'roast' | 'v2-spawn' = 'idle';
  const v1Row = db.$raw
    .prepare(
      `SELECT created_at FROM events
        WHERE entity_type = 'ticket' AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') = 'iterate-version'
          AND json_extract(payload, '$.version') = 1
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as { created_at: number } | undefined;
  const roastRow = db.$raw
    .prepare(
      `SELECT created_at FROM events
        WHERE entity_type = 'ticket' AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') = 'iterate-roast'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as { created_at: number } | undefined;
  if (v1Row && !roastRow) phase = 'lead-v1';
  if (v1Row && roastRow) phase = 'roast';

  // Sub-Plan 04 Welle 2 (2026-04-29) — currentVersion + isFinal für
  // IteratePipelineCard. maxVersion = höchste iterate-version im Ticket.
  const maxVersionRow = db.$raw
    .prepare(
      `SELECT MAX(CAST(json_extract(payload,'$.version') AS INTEGER)) as v
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'`,
    )
    .get(ws.primary_ticket_id) as { v: number | null } | undefined;
  const currentVersion = maxVersionRow?.v ?? 0;
  // isFinal = workstream.status='done' ODER Master.workflowState='review'+
  const masterRow = db.$raw
    .prepare("SELECT workflow_state FROM tickets WHERE id=?")
    .get(ws.primary_ticket_id) as { workflow_state: string | null } | undefined;
  const masterState = masterRow?.workflow_state ?? null;
  const isFinal = masterState === 'review' ||
    masterState === 'approved' ||
    masterState === 'executing' ||
    masterState === 'executed' ||
    masterState === 'closed';

  if (!pauseRow) {
    return NextResponse.json({
      isPaused: false,
      remainingMs: 0,
      after: null,
      phase,
      currentVersion,
      isFinal,
      masterState,
      workstreamStatus: ws.status,
    });
  }

  let durationMs = 0;
  let after: string | null = null;
  let pauseKind: string | null = null;
  try {
    const p = JSON.parse(pauseRow.payload) as {
      durationMs?: number;
      pauseDurationMs?: number;
      after?: string;
      kind?: string;
    };
    // Phase RA.4: auto-dispatch-pause nutzt `pauseDurationMs`, sniper-
    // pause-start nutzt `durationMs`. Wir akzeptieren beide.
    durationMs = typeof p.durationMs === 'number'
      ? p.durationMs
      : typeof p.pauseDurationMs === 'number'
        ? p.pauseDurationMs
        : 0;
    after = p.after ?? (p.kind === 'auto-dispatch-pause' ? 'auto-dispatch' : 'roast');
    pauseKind = p.kind ?? null;
  } catch {
    /* ignore */
  }

  // Wurde nach dem Pause-Start schon eine neue iterate-version,
  // synthesis oder auto-dispatch-cancelled/-overview emittet? Dann ist
  // die Pause de-facto vorbei.
  const nextVersionRow = db.$raw
    .prepare(
      `SELECT created_at FROM events
        WHERE entity_type = 'ticket'
          AND entity_id = ?
          AND event_type = 'commented'
          AND json_extract(payload, '$.kind') IN (
            'iterate-version',
            'synthesis',
            'auto-dispatch-cancelled',
            'auto-dispatch-spawn-started'
          )
          AND created_at > ?
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    .get(ws.primary_ticket_id, pauseRow.created_at) as
    | { created_at: number }
    | undefined;

  const now = Date.now();
  const deadline = pauseRow.created_at + durationMs;
  const isPaused = !nextVersionRow && now < deadline;
  const remainingMs = isPaused ? Math.max(0, deadline - now) : 0;

  return NextResponse.json({
    isPaused,
    remainingMs,
    after,
    phase,
    pauseKind,
    pauseStartedAt: pauseRow.created_at,
    durationMs,
    currentVersion,
    isFinal,
    masterState,
    workstreamStatus: ws.status,
  });
}
