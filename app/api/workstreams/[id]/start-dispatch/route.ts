/**
 * POST /api/workstreams/[id]/start-dispatch
 *
 * Phase AC.2 (2026-04-26) — consensus quick-start.
 *
 * Sets a workstream's master ticket to `workflowState='approved'`
 * via an `updated` event. The event hook in `lib/events/emit.ts` then
 * triggers `maybeAutoDispatch` (Phase AD), which spawns the sub-pipelines.
 *
 * Idempotent: if the master is already approved, we return 200/no-op.
 *
 * Auth: cookie session.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  readSessionConfig,
  readSessionCookie,
  verifySessionCookieValue,
} from '@/lib/security/session';
import { getWorkstream } from '@/lib/workstreams/service';
import { emitEvent } from '@/lib/events/emit';
import type { ActorType } from '@/lib/events/types';
import { currentActor } from '@/lib/security/subject';
import { getTicket } from '@/lib/tickets/service';
import { maybeAutoDispatch } from '@/lib/tickets/auto-dispatch';
import { getDb } from '@/db/client';
import { ulid } from '@/lib/ulid';

// Sub-Plan G (2026-04-30): double-spawn lock. Lock TTL = 60 s. After expiry
// a new caller may acquire the lock, because the previous spawn either
// has long been running (=has its own tmux sessions) or crashed and never
// released. 60 s is much shorter than the iterate pipeline wallclock (3-18 min),
// but long enough to absorb real double-clicks.
const DISPATCH_LOCK_TTL_MS = 60_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  // ---- Auth
  const cookieCfg = readSessionConfig();
  if (!cookieCfg) {
    return NextResponse.json(
      { error: 'auth_not_configured' },
      { status: 503 },
    );
  }
  const cookieValue = readSessionCookie(req.headers.get('cookie'));
  const verified = await verifySessionCookieValue(cookieValue, cookieCfg);
  if (!verified.ok) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id: workstreamId } = await ctx.params;
  if (!workstreamId) {
    return NextResponse.json({ error: 'missing_id' }, { status: 400 });
  }

  const ws = await getWorkstream(workstreamId).catch(() => null);
  if (!ws) {
    return NextResponse.json({ error: 'workstream_not_found' }, { status: 404 });
  }

  const masterTicketId = ws.primaryTicketId;
  if (!masterTicketId) {
    return NextResponse.json(
      { error: 'no_master_ticket' },
      { status: 400 },
    );
  }

  const master = await getTicket(masterTicketId).catch(() => null);
  if (!master) {
    return NextResponse.json(
      { error: 'master_ticket_not_found' },
      { status: 404 },
    );
  }

  // If already `closed` → no-op, everything done.
  if (master.workflowState === 'closed') {
    return NextResponse.json({
      ok: true,
      already: true,
      state: 'closed',
    });
  }

  // Sub-Plan G (2026-04-30): atomic lock acquire. The UPDATE matches only if
  // (a) no token is set OR (b) the existing token is older than 60 s
  // (= the previous spawn probably crashed). 0 rows changed → 409.
  // On success we set lock_token=ulid() + lock_ts=now.
  const newLockToken = ulid();
  const lockExpireBefore = Date.now() - DISPATCH_LOCK_TTL_MS;
  let lockAcquired = false;
  try {
    const db = getDb();
    const stmt = db.$raw.prepare(
      `UPDATE workstreams
          SET dispatch_lock_token = ?,
              dispatch_lock_ts = ?
        WHERE id = ?
          AND (dispatch_lock_token IS NULL
               OR dispatch_lock_ts IS NULL
               OR dispatch_lock_ts < ?)`,
    );
    const res = stmt.run(
      newLockToken,
      Date.now(),
      workstreamId,
      lockExpireBefore,
    );
    // better-sqlite3 provides .changes; if the driver differs, fall back to 0.
    const changes =
      typeof (res as { changes?: number }).changes === 'number'
        ? (res as { changes: number }).changes
        : 0;
    lockAcquired = changes > 0;
  } catch (err) {
    console.warn('[start-dispatch] lock-acquire failed:', err);
    // The lock mechanism must not hard-block the dispatch if the DB
    // has an edge error. We log + continue with lockAcquired=false
    // → 409, and the client retries cleanly.
  }
  if (!lockAcquired) {
    // Read the current lock status for sinceMs.
    let sinceMs = 0;
    try {
      const db = getDb();
      const row = db.$raw
        .prepare(
          'SELECT dispatch_lock_ts FROM workstreams WHERE id = ?',
        )
        .get(workstreamId) as { dispatch_lock_ts: number | null } | undefined;
      if (row?.dispatch_lock_ts) {
        sinceMs = Date.now() - row.dispatch_lock_ts;
      }
    } catch {
      /* non-fatal */
    }
    return NextResponse.json(
      { error: 'already-dispatching', sinceMs },
      { status: 409 },
    );
  }

  // If `approved`/`executing` but auto-dispatch never ran (e.g.
  // because the service restarted between approve and queueMicrotask),
  // we force the call directly — maybeAutoDispatch has its own
  // echo guards (sub-tickets already in the executing state are skipped).
  const actor = currentActor(req) as ActorType;
  if (master.workflowState === 'approved' || master.workflowState === 'executing') {
    const fakeEvent = {
      id: `force-${Date.now()}`,
      createdAt: Date.now(),
      segmentId: ws.workspaceId,
      entityType: 'ticket' as const,
      entityId: masterTicketId,
      eventType: 'updated' as const,
      actor,
      payload: {
        workflowState: 'approved',
        reason: 'force_dispatch_recovery',
        workstreamId,
        // Sub-Plan G (2026-04-30): send the lock token along in the payload —
        // helps with tracing and echo detection in subsequent
        // auto-dispatch phases.
        dispatchLockToken: newLockToken,
      },
      sensitivity: 'low' as const,
    };
    void maybeAutoDispatch(fakeEvent).catch((err) => {
      console.warn('[start-dispatch] force-dispatch failed:', err);
    });
    return NextResponse.json({
      ok: true,
      forced: true,
      state: master.workflowState,
      lockToken: newLockToken,
    });
  }

  // Otherwise: the regular path. Emit the updated event, the event hook
  // calls maybeAutoDispatch automatically via queueMicrotask.
  await emitEvent({
    segmentId: ws.workspaceId,
    entityType: 'ticket',
    entityId: masterTicketId,
    eventType: 'updated',
    actor,
    payload: {
      workflowState: 'approved',
      reason: 'consensus_quick_start',
      workstreamId,
      dispatchLockToken: newLockToken,
    },
    sensitivity: 'low',
  });

  return NextResponse.json({
    ok: true,
    dispatched: true,
    lockToken: newLockToken,
  });
}
