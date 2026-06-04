/**
 * GET /api/workstreams/[id]/questions — Sub-Plan 02 (2026-04-29).
 *
 * Extrahiert die `## Offene Fragen` Section aus dem letzten iterate-version-
 * Event-Payload des Workstreams. Plus: alle user-correction-Antworten seit
 * V_n damit das UI „beantwortet"-Status zeigen kann.
 *
 * Response:
 *   {
 *     workstreamId,
 *     fromVersion: number,                  // V_n des Plans
 *     questions: Array<{ id, text }>,
 *     answers: Array<{ id?, text, ts }>     // user-correction-Events
 *   }
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { parsePlanQuestions } from '@/lib/workstreams/parse-plan-questions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WsRow {
  workspace_id: string;
  primary_ticket_id: string | null;
}

export async function GET(
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
      'SELECT workspace_id, primary_ticket_id FROM workstreams WHERE id = ?',
    )
    .get(workstreamId) as WsRow | undefined;
  if (!ws || !ws.primary_ticket_id) {
    return NextResponse.json(
      { workstreamId, fromVersion: 0, questions: [], answers: [] },
      { status: 200 },
    );
  }
  if (!canReadWorkspace(getEffectiveWorkspaceRole(userId, ws.workspace_id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Letzten iterate-version-Event suchen — höchste Version, sonst created_at
  const planRow = db.$raw
    .prepare(
      `SELECT created_at,
              CAST(json_extract(payload,'$.version') AS INTEGER) as version,
              json_extract(payload,'$.text') as text
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'
        ORDER BY version DESC, created_at DESC
        LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as
    | { created_at: number; version: number | null; text: string | null }
    | undefined;

  if (!planRow || !planRow.text) {
    return NextResponse.json({
      workstreamId,
      fromVersion: 0,
      questions: [],
      answers: [],
    });
  }

  const fromVersion = planRow.version ?? 0;
  const questions = parsePlanQuestions(planRow.text);

  // Antworten: user-correction-Events seit Plan-Erstellung
  const answerRows = db.$raw
    .prepare(
      `SELECT created_at, json_extract(payload,'$.message') as msg
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='user-correction'
          AND created_at >= ?
        ORDER BY created_at ASC`,
    )
    .all(ws.primary_ticket_id, planRow.created_at) as Array<{
    created_at: number;
    msg: string | null;
  }>;

  const answers = answerRows
    .filter((a) => a.msg)
    .map((a) => ({
      text: a.msg!,
      ts: a.created_at,
    }));

  return NextResponse.json({
    workstreamId,
    fromVersion,
    questions,
    answers,
  });
}
