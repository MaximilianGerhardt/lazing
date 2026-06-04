/**
 * POST /api/chat/open-questions/dismiss — 2026-05-28 (workstream open-questions
 * lifecycle, owner spec D „manueller Dismiss pro Frage").
 *
 * Called by the client-side pill dismiss (ChatShell → onDismiss).
 * Writes a `workstream_decisions` row so the lifetime history of the
 * pinned pill is not silent (N8 — trace is evidence, not telemetry).
 *
 * NO destructive side effect: no DB update to `events`, no chat-message
 * edit. The open question still stands in the assistant message; only the
 * pill display in the current tab is gone. On reload it would reappear without the
 * lifecycle reducer (stale-resolve / answered / dismissed) —
 * but the reducer removes it again immediately as soon as the population effect
 * recycles it out of the history. This endpoint is the N8 trace BEFORE that.
 *
 * DECISION-KIND CHOICE:
 *   - The enum allowed by migration 0071 (see DecisionKind in
 *     `lib/workstreams/trace-repo.ts`) contains NO dedicated
 *     `question-dismissed` value. We choose `override` — the semantically
 *     closest variant ("the user overruled a recommendation/question from the
 *     agent"). The reasoning is in the rationale text verbatim (N1).
 *
 * FAIL-SOFT: every error condition (no workstreamId, wrong permission,
 * writeDecision throws) becomes a 200 OK with `{ ok: false, reason: ... }`.
 * The client should never fail because the N8 trace was not writable —
 * the pill disappears on the UI side even without the audit.
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
  // Auth gate. Without a user there is no point in an audit trace.
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

  // Required fields. If the client has no workstreamId (free-chat without
  // an active workstream), it may still hit the endpoint — the response
  // is then „ok=false, no-workstream", the pill dismiss still goes
  // through on the UI side (fail-soft).
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
    // Here too: not 403. The pill dismiss is a UI action, the audit
    // write is a bonus. We signal honestly, but do not block.
    return NextResponse.json(
      { ok: false, reason: 'forbidden' },
      { status: 200 },
    );
  }

  // Rationale verbatim (N1) — the question ID + trimmed question text + owner
  // action. No .slice/.substring (N1 lint).
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
    // Fail-soft — never block the user flow because of an audit error.
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
