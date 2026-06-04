/**
 * POST /api/subchats/[subchatId]/typing  — TRANSIENT typing signal (internal).
 *
 * Auth: member of the workspace (mirrored from messages/route.ts). Persists
 * NOTHING — builds an ephemeral `subchat_typing` LazyEvent and only broadcasts
 * it to SSE subscribers. No DB insert, no push. Best-effort, idempotency-agnostic.
 * Bundle 1 (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { broadcast } from '@/lib/events/broadcast';
import { ulid } from '@/lib/ulid';
import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat } from '@/lib/subchats/service';
import type { LazyEvent } from '@/lib/events/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ subchatId: string }>;
}

async function resolveAndGate(
  req: NextRequest,
  subchatId: string,
): Promise<{ ok: true; userId: string; workspaceId: string } | { ok: false; res: Response }> {
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) {
    return { ok: false, res: NextResponse.json({ error: 'invalid_subchat_id' }, { status: 400 }) };
  }
  const sc = getSubchat(subchatId);
  if (!sc) return { ok: false, res: NextResponse.json({ error: 'subchat_not_found' }, { status: 404 }) };
  const userId = currentUserIdResolved(req);
  if (!userId) return { ok: false, res: NextResponse.json({ error: 'auth-required' }, { status: 401 }) };
  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return { ok: false, res: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { ok: true, userId, workspaceId: sc.workspaceId };
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;

  // Optional display name of the typist (short). Default: 'Team'.
  // `clientId`: client-generated mount nonce — broadcast along so the
  // sender can suppress their OWN typing echo (otherwise "Team is typing …"
  // on their own screen).
  let who = 'Team';
  let fromClientId = '';
  try {
    const body = (await req.json()) as { who?: string; clientId?: string };
    if (typeof body.who === 'string' && body.who.trim()) who = body.who.trim().slice(0, 80);
    if (typeof body.clientId === 'string') fromClientId = body.clientId.slice(0, 40);
  } catch {
    /* empty body allowed */
  }

  // EPHEMERAL: NO db.insert, NO emitEvent. Only broadcast → SSE subscribers.
  const now = Date.now();
  const ev: LazyEvent = {
    id: ulid(now),
    createdAt: now,
    segmentId: g.workspaceId,
    entityType: 'subchat',
    entityId: subchatId,
    eventType: 'subchat_typing',
    actor: 'system',
    // fromUserId: so the client can suppress its OWN typing echo
    // (otherwise the operator would see their own typing as "Team is typing …").
    payload: { subchatId, workspaceId: g.workspaceId, who, fromUserId: g.userId, fromClientId },
    sensitivity: 'low',
  };
  try {
    broadcast.publish(ev);
  } catch {
    /* best-effort */
  }
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
