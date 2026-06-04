/**
 * POST /api/workstreams/[id]/finalize — Sub-Plan 04 (2026-04-29).
 *
 * Pragmatic helper: make a ConsensusActionCard appear in the chat for an
 * iterate-finished workstream. Sets the master ticket's
 * workflowState=`review`, aggregates outliers from roaster events and
 * emits a chat_message_completed with a `<surface:consensus-action>` tag
 * (incl. outliers inline data).
 *
 * Auth: cookie session OR Bearer LAZYOS_CHAT_KEY.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { emitEvent, emitChatMessageCompleted } from '@/lib/events/emit';
import { emitOrUpdateCard } from '@/lib/events/emit-or-update-card';
import { ulid } from '@/lib/ulid';
import {
  parseSubTicketsBlock,
  createSubTicketEvent,
} from '@/server/agents/tier-orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface WsRow {
  id: string;
  workspace_id: string;
  primary_ticket_id: string | null;
  status: string;
  name: string;
}

async function authOk(req: NextRequest): Promise<{ userId: string } | null> {
  const userId = currentUserIdResolved(req);
  if (userId) return { userId };
  const auth = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m) {
    const expected = (process.env.LAZYOS_CHAT_KEY ?? '').trim();
    if (expected.length > 0 && m[1] === expected) return { userId: '@system' };
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
      'SELECT id, workspace_id, primary_ticket_id, status, name FROM workstreams WHERE id=?',
    )
    .get(workstreamId) as WsRow | undefined;
  if (!ws || !ws.primary_ticket_id) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  if (
    auth.userId !== '@system' &&
    !canEditWorkspaceContent(getEffectiveWorkspaceRole(auth.userId, ws.workspace_id))
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const planRow = db.$raw
    .prepare(
      `SELECT json_extract(payload,'$.text') as text,
              CAST(json_extract(payload,'$.version') AS INTEGER) as version,
              created_at
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-version'
        ORDER BY version DESC, created_at DESC LIMIT 1`,
    )
    .get(ws.primary_ticket_id) as
    | { text: string | null; version: number | null; created_at: number }
    | undefined;
  if (!planRow?.text) {
    return NextResponse.json(
      { error: 'no-iterate-version', hint: 'Master-Ticket hat keine iterate-version-Events.' },
      { status: 400 },
    );
  }

  // Idempotency check (disableable with ?force=1 — e.g. when a new
  // card payload with subTickets/planText should be emitted).
  const url = new URL(req.url);
  // Sub-Plan C (2026-04-30): card dedup is handled centrally in emitOrUpdateCard.
  // We keep the `force=1` mode as a force-insert: in that case
  // we bypass the helper and fire emitChatMessageCompleted directly, so that
  // a new event row is created (e.g. after "plan completely discarded").
  const force = url.searchParams.get('force') === '1';

  // Outlier aggregation from the roaster events of the last wave.
  const sinceMs = planRow.created_at - 60_000;
  const roastRows = db.$raw
    .prepare(
      `SELECT json_extract(payload,'$.roasterLabel') as label,
              json_extract(payload,'$.text') as text
         FROM events
        WHERE entity_type='ticket' AND entity_id=?
          AND event_type='commented'
          AND json_extract(payload,'$.kind')='iterate-roast'
          AND created_at >= ?`,
    )
    .all(ws.primary_ticket_id, sinceMs) as Array<{
    label: string | null;
    text: string | null;
  }>;
  const outliers = roastRows
    .filter((r) => r.text)
    .map((r) => ({
      cluster: r.label ?? 'Roaster',
      summary: (r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 220),
    }))
    .slice(0, 4);

  // workflowState='review' update event
  await emitEvent({
    segmentId: ws.workspace_id,
    entityType: 'ticket',
    entityId: ws.primary_ticket_id,
    eventType: 'updated',
    actor: 'system',
    payload: {
      workflowState: 'review',
      transition: 'iterate-final',
      workstreamId: ws.id,
    },
    sensitivity: 'low',
  }).catch(() => undefined);

  // update the tickets table workflow_state column if it exists
  try {
    db.$raw
      .prepare("UPDATE tickets SET workflow_state='review' WHERE id=?")
      .run(ws.primary_ticket_id);
  } catch {
    /* event-sourced — doesn't matter */
  }

  // Sub-Plan 04 wave 1 fix (2026-04-29) — extract sub-tickets from the
  // plan YAML and emit them as ticket-created events. Auto-dispatch
  // needs this (lib/tickets/auto-dispatch.ts maybeAutoDispatch looks for
  // sub-tickets via parent_ticket_id).
  let subTicketsCreated = 0;
  let subTicketsSkipped = 0;
  const existingSubsRow = db.$raw
    .prepare(
      `SELECT count(*) as c FROM events
        WHERE event_type='created'
          AND json_extract(payload,'$.parentTicketId')=?`,
    )
    .get(ws.primary_ticket_id) as { c: number } | undefined;
  const alreadyHasSubs = (existingSubsRow?.c ?? 0) > 0;
  if (alreadyHasSubs) {
    subTicketsSkipped = existingSubsRow!.c;
  } else {
    const parsed = parseSubTicketsBlock(planRow.text);
    for (const sub of parsed) {
      await createSubTicketEvent({
        workspaceId: ws.workspace_id,
        parentTicketId: ws.primary_ticket_id,
        workstreamId: ws.id,
        title: sub.title,
        prio: sub.prio,
        body: sub.body,
      });
      subTicketsCreated += 1;
    }
  }

  // Sub-Plan 05 (2026-04-29) — sub-tickets list for the inline section
  const subRows = db.$raw
    .prepare(
      `SELECT json_extract(payload,'$.title') as title,
              json_extract(payload,'$.prio') as prio
         FROM events
        WHERE event_type='created'
          AND json_extract(payload,'$.parentTicketId')=?
        ORDER BY created_at ASC LIMIT 12`,
    )
    .all(ws.primary_ticket_id) as Array<{
    title: string | null;
    prio: string | null;
  }>;
  const subTicketsLite = subRows
    .filter((s) => s.title)
    .map((s) => ({ title: s.title!, prio: s.prio ?? 'P2' }));

  // chat_message_completed with a ConsensusActionCard surface tag
  const consensusJson = JSON.stringify({
    workstreamId: ws.id,
    consensusLevel: 'majority',
    masterTicketId: ws.primary_ticket_id,
    outliers,
    subTickets: subTicketsLite,
    planText: planRow.text.slice(0, 6000),
  });
  const cardText = [
    `**Master-Plan V${planRow.version ?? '?'} fertig — ${ws.name}**`,
    '',
    'Der iterate-Loop hat einen finalen Plan produziert. Sub-Tickets sind',
    'extrahiert. „Los" startet die autonome Umsetzung mit Auto-Dispatch',
    '(25 s Sniper-Pause vor Spawn — du kannst noch eingreifen).',
    '',
    `<surface:consensus-action>${consensusJson}</surface:consensus-action>`,
  ].join('\n');

  let eventId: string | null = null;
  let cardEmit: 'emitted' | 'updated' | 'force-emitted' = 'emitted';
  if (force) {
    const ev = await emitChatMessageCompleted({
      workspaceId: ws.workspace_id,
      entityId: ulid(),
      content: cardText,
      actor: 'system',
      outcome: 'ok',
      metadata: {
        surfaceKind: 'consensus-action',
        workstreamId: ws.id,
      },
    });
    eventId = ev.id;
    cardEmit = 'force-emitted';
  } else {
    const result = await emitOrUpdateCard({
      coords: {
        workspaceId: ws.workspace_id,
        workstreamId: ws.id,
        surfaceKind: 'consensus-action',
      },
      content: cardText,
      actor: 'system',
    });
    eventId = result.event.id;
    cardEmit = result.mode === 'updated' ? 'updated' : 'emitted';
  }

  return NextResponse.json({
    ok: true,
    workstreamId: ws.id,
    masterTicketId: ws.primary_ticket_id,
    workflowState: 'review',
    outliers,
    cardEmit,
    subTickets: { created: subTicketsCreated, alreadyExisting: subTicketsSkipped },
    eventId,
  });
}
