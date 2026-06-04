/**
 * POST /api/subchats/[subchatId]/read   — Sub-Chat als gelesen markieren.
 *
 * Auth: Member des Workspace (gespiegelt aus messages/route.ts). Optionaler
 * Body { ts }; default now. Mutation über lib/subchats/service.markRead.
 * Gathering-Intelligence-Goal P2 (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat, markRead } from '@/lib/subchats/service';

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
  let ts: number | undefined;
  try {
    const body = (await req.json()) as { ts?: number };
    ts = typeof body.ts === 'number' && Number.isFinite(body.ts) ? body.ts : undefined;
  } catch {
    ts = undefined; // leerer/kein Body ist erlaubt — default now
  }
  markRead(subchatId, g.userId, ts);
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
