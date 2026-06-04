/**
 * POST /api/chat/open-questions/dismiss — 2026-05-28 (Workstream Open-Questions-
 * Lifecycle, Owner-Spec D „manueller Dismiss pro Frage").
 *
 * Wird vom Client-seitigen Pill-Dismiss aufgerufen (ChatShell → onDismiss).
 * Schreibt eine `workstream_decisions`-Row, damit der Lifetime-Verlauf der
 * gepinnten Pill nicht silent ist (N8 — Trace ist Evidence, nicht Telemetry).
 *
 * KEIN destruktiver Side-Effect: kein DB-Update an `events`, kein chat-message-
 * Edit. Die offene Frage steht weiter in der assistant-Message; nur die
 * Pill-Anzeige im aktuellen Tab ist weg. Beim Reload würde sie ohne den
 * Lifecycle-Reducer (stale-resolve / answered / dismissed) wieder erscheinen —
 * der Reducer entfernt sie aber sofort wieder, sobald der Population-Effect
 * sie aus der History rezykliert. Dieser Endpoint ist die N8-Spur DAVOR.
 *
 * DECISION-KIND-WAHL:
 *   - Das aus Migration 0071 zulässige Enum (siehe DecisionKind in
 *     `lib/workstreams/trace-repo.ts`) enthält KEINEN dedizierten
 *     `question-dismissed`-Wert. Wir wählen `override` — die semantisch
 *     nächstliegende Variante („User hat eine Empfehlung/Frage des Agents
 *     überstimmt"). Begründung steht im rationale-Text verbatim drin (N1).
 *
 * FAIL-SOFT: jede Fehlerbedingung (kein workstreamId, falsche Permission,
 * writeDecision wirft) wird zu einer 200 OK mit `{ ok: false, reason: ... }`.
 * Der Client soll nie scheitern, weil die N8-Spur nicht schreibbar war —
 * die Pill verschwindet UI-seitig auch ohne Audit.
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
}

interface DismissBody {
  workstreamId?: unknown;
  questionId?: unknown;
  questionText?: unknown;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

export async function POST(req: NextRequest): Promise<Response> {
  // Auth-Gate. Ohne user keine Audit-Spur sinnvoll.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  let body: DismissBody;
  try {
    body = (await req.json()) as DismissBody;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }

  const workstreamId = asNonEmptyString(body.workstreamId);
  const questionId = asNonEmptyString(body.questionId);
  const questionText = asNonEmptyString(body.questionText);

  // Pflicht-Felder. Wenn der Client kein workstreamId hat (Free-Chat ohne
  // aktiven Workstream), darf er den Endpoint trotzdem treffen — Antwort
  // ist dann „ok=false, no-workstream", der Pill-Dismiss läuft trotzdem
  // UI-seitig durch (fail-soft).
  if (!questionId) {
    return NextResponse.json(
      { ok: false, reason: 'missing-questionId' },
      { status: 200 },
    );
  }
  if (!workstreamId) {
    return NextResponse.json(
      { ok: false, reason: 'no-workstream', note: 'free-chat dismiss — UI-only' },
      { status: 200 },
    );
  }

  const db = getDb();
  const ws = db.$raw
    .prepare('SELECT workspace_id FROM workstreams WHERE id = ?')
    .get(workstreamId) as WsRow | undefined;
  if (!ws) {
    return NextResponse.json(
      { ok: false, reason: 'workstream-not-found' },
      { status: 200 },
    );
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspace_id))) {
    // Auch hier: nicht 403. Der Pill-Dismiss ist eine UI-Aktion, der Audit-
    // Write ist ein Bonus. Wir signalisieren ehrlich, aber blockieren nicht.
    return NextResponse.json(
      { ok: false, reason: 'forbidden' },
      { status: 200 },
    );
  }

  // Rationale verbatim (N1) — die Frage-ID + getrimmter Frage-Text + Owner-
  // Aktion. Kein .slice/.substring (N1-Lint).
  const rationaleParts: string[] = [
    `User hat die offene Frage „${questionId}" via Pill-Dismiss entfernt.`,
  ];
  if (questionText) rationaleParts.push(`Frage-Text: ${questionText}`);
  rationaleParts.push(
    'decision_kind=override gewählt (Enum 0071 hat keinen dedizierten "question-dismissed"-Wert) — User-Override über eine vom Agent gestellte offene Frage.',
  );
  const rationale = rationaleParts.join(' ');

  try {
    const id = writeDecision({
      workspaceId: ws.workspace_id,
      workstreamId,
      coordKey: `${ws.workspace_id}/${workstreamId}`,
      decisionKind: 'override',
      rationale,
      actor: 'user',
    });
    return NextResponse.json({
      ok: id !== null,
      decisionId: id,
      note: id === null ? 'writeDecision returned null (best-effort)' : undefined,
    });
  } catch (err) {
    // Fail-soft — niemals den User-Flow blockieren wegen eines Audit-Fehlers.
    console.warn(
      '[open-questions/dismiss] writeDecision threw (non-fatal):',
      err,
    );
    return NextResponse.json(
      { ok: false, reason: 'write-failed' },
      { status: 200 },
    );
  }
}
