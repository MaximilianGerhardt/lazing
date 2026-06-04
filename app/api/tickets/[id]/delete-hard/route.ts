/**
 * DELETE /api/tickets/[id]/delete-hard
 *
 * Real deletion: emit ticket_deleted event. The projection then filters the
 * ticket out of the list entirely. Events remain in the log (audit trail).
 */

import { NextResponse } from 'next/server';
import { emitEvent } from '@/lib/events/emit';
import type { ActorType } from '@/lib/events/types';
import { currentActor } from '@/lib/security/subject';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  if (!id || !/^TCK-[A-Z0-9]{10,30}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid_ticket_id' }, { status: 400 });
  }
  try {
    await emitEvent({
      segmentId: 'lazyos',
      entityType: 'ticket',
      entityId: id,
      eventType: 'ticket_deleted',
      actor: currentActor(req) as ActorType,
      payload: { reason: 'user_initiated_delete' },
      sensitivity: 'low',
    });
    return NextResponse.json({ ok: true, ticketId: id, deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'delete_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
