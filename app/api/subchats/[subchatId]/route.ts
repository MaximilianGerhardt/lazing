/**
 * PATCH  /api/subchats/[subchatId]   — rename sub-chat (member-gated).
 * DELETE /api/subchats/[subchatId]   — hard-delete sub-chat (member-gated).
 *
 * Auth: member of the workspace the sub-chat belongs to (mirrored from
 * messages/route.ts). Mutations go exclusively through lib/subchats/service.
 * Gathering-Intelligence goal P2 (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { deleteSubchat, getSubchat, renameSubchat } from '@/lib/subchats/service';

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

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  let body: { title?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const title = (body.title ?? '').trim();
  if (title.length < 1 || title.length > 200) {
    return NextResponse.json({ error: 'invalid-title', hint: 'Titel benötigt' }, { status: 400 });
  }
  const sc = renameSubchat(subchatId, title);
  if (!sc) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
  return NextResponse.json(
    { subchat: { id: sc.id, title: sc.title, kind: sc.kind, status: sc.status, updatedAt: sc.updatedAt } },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  const ok = deleteSubchat(subchatId);
  if (!ok) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
