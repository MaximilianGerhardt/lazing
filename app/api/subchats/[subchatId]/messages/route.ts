/**
 * GET  /api/subchats/[subchatId]/messages  — Nachrichten lesen (intern, member).
 * POST /api/subchats/[subchatId]/messages  — als internes Team-Mitglied posten.
 *
 * Auth: Member des Workspace, zu dem der Sub-Chat gehört.
 * Gathering-Intelligence-Goal (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  getSubchat,
  listMessages,
  parseAttachments,
  postMessage,
  recipientLastReadTs,
  sanitizeAttachments,
  type SubchatMessageRow,
} from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ subchatId: string }>;
}

function serialize(m: SubchatMessageRow) {
  return {
    id: m.id,
    authorKind: m.authorKind,
    authorName: m.authorName,
    content: m.content,
    attachments: parseAttachments(m.attachments),
    createdAt: m.createdAt,
  };
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

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  const sc = getSubchat(subchatId)!;
  const messages = listMessages(subchatId).map(serialize);
  const recipientReadTs = recipientLastReadTs(subchatId, g.userId);
  return NextResponse.json(
    {
      subchat: { id: sc.id, title: sc.title, kind: sc.kind, workspaceId: sc.workspaceId },
      messages,
      recipientReadTs, // subchat-level watermark (ms epoch, 0 = none)
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  let body: { content?: string; authorName?: string; attachments?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const content = (body.content ?? '').trim();
  const attachments = sanitizeAttachments(body.attachments, g.workspaceId);
  // Eine Nachricht braucht Text ODER mindestens einen Anhang.
  if ((content.length < 1 && attachments.length === 0) || content.length > 8000) {
    return NextResponse.json({ error: 'invalid-content' }, { status: 400 });
  }
  const msg = postMessage({
    subchatId,
    workspaceId: g.workspaceId,
    authorKind: 'internal',
    authorId: g.userId,
    authorName: body.authorName?.trim() || 'Team',
    content,
    attachments,
  });
  return NextResponse.json({ message: serialize(msg) }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}
