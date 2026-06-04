/**
 * POST /api/workstreams/[id]/start-dispatch
 *
 * Phase AC.2 (2026-04-26) — Konsens-Quick-Start.
 *
 * Setzt das Master-Ticket eines Workstreams auf `workflowState='approved'`
 * via `updated`-Event. Der Event-Hook in `lib/events/emit.ts` triggert
 * dann `maybeAutoDispatch` (Phase AD), was die Sub-Pipelines spawnt.
 *
 * Idempotent: Wenn Master schon approved ist, returnen wir 200/no-op.
 *
 * Auth: Cookie-Session.
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

// Sub-Plan G (2026-04-30): Doppel-Spawn-Lock. Lock-TTL = 60 s. Nach Ablauf
// darf ein neuer Caller den Lock erwerben, weil der vorherige Spawn entweder
// längst läuft (=hat eigene tmux-Sessions) oder gecrasht ist und nie released
// hat. 60 s ist deutlich kürzer als die Iterate-Pipeline-Wallclock (3-18 min),
// aber lang genug um echte Doppel-Klicks zu absorbieren.
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

  // Wenn schon `closed` → no-op, alles fertig.
  if (master.workflowState === 'closed') {
    return NextResponse.json({
      ok: true,
      already: true,
      state: 'closed',
    });
  }

  // Sub-Plan G (2026-04-30): atomic Lock-Acquire. UPDATE matcht nur wenn
  // (a) kein Token gesetzt ODER (b) der bestehende Token älter als 60 s ist
  // (= vorheriger Spawn vermutlich gecrasht). 0 rows changed → 409.
  // Bei Erfolg setzen wir lock_token=ulid() + lock_ts=now.
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
    // better-sqlite3 liefert .changes; falls Treiber abweicht, fallback auf 0.
    const changes =
      typeof (res as { changes?: number }).changes === 'number'
        ? (res as { changes: number }).changes
        : 0;
    lockAcquired = changes > 0;
  } catch (err) {
    console.warn('[start-dispatch] lock-acquire failed:', err);
    // Lock-Mechanik darf den Dispatch nicht hart blockieren wenn die DB
    // einen edge-Fehler hat. Wir loggen + weiterlaufen mit lockAcquired=false
    // → 409, der Client retried sauber.
  }
  if (!lockAcquired) {
    // Lese aktuellen Lock-Status für sinceMs.
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
      /* nicht-fatal */
    }
    return NextResponse.json(
      { error: 'already-dispatching', sinceMs },
      { status: 409 },
    );
  }

  // Wenn `approved`/`executing` aber Auto-Dispatch nie lief (z.B.
  // weil der Service zwischen Approve und queueMicrotask restartet hat),
  // forcen wir den Aufruf direkt — maybeAutoDispatch hat eigene
  // Echo-Guards (sub-tickets schon im executing-State werden uebersprungen).
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
        // Sub-Plan G (2026-04-30): Lock-Token im Payload mitschicken —
        // hilft beim Tracing und für Echo-Erkennung in nachfolgenden
        // Auto-Dispatch-Phasen.
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

  // Sonst: regulaerer Pfad. updated-Event emittieren, Event-Hook ruft
  // maybeAutoDispatch automatisch auf via queueMicrotask.
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
