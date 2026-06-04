/**
 * GET  /api/subchats/external/[token]  — resolve sub-chat via share token
 *                                        (public, NO login) + messages.
 * POST /api/subchats/external/[token]  — post as an external guest (name + text).
 *
 * The token IS the authorization (hashed in the DB). External parties NEVER see
 * the AI. Every message flows into the workspace RAG (via postMessage → ingest).
 * Public route — in middleware.ts under PUBLIC_PREFIXES `/api/subchats/external/`.
 *
 * Gathering-Intelligence goal (2026-06-02).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  listMessages,
  parseAttachments,
  postMessage,
  resolveExternalToken,
  sanitizeAttachments,
  type SubchatMessageRow,
} from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ token: string }>;
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

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const sc = resolveExternalToken(token);
  if (!sc) {
    return NextResponse.json({ error: 'invalid_or_expired' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const messages = listMessages(sc.id).map(serialize);
  // Only what an external guest is allowed to see — NO internal IDs/tokens.
  return NextResponse.json(
    {
      subchat: { id: sc.id, title: sc.title },
      messages,
      // subtle transparency notice (GDPR/trust, confirmed by the owner).
      notice: 'Diese Konversation wird für die Projektbearbeitung gespeichert.',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const sc = resolveExternalToken(token);
  if (!sc) {
    return NextResponse.json({ error: 'invalid_or_expired' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  let body: { content?: string; name?: string; attachments?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const content = (body.content ?? '').trim();
  const attachments = sanitizeAttachments(body.attachments, sc.workspaceId);
  if ((content.length < 1 && attachments.length === 0) || content.length > 8000) {
    return NextResponse.json({ error: 'invalid-content' }, { status: 400 });
  }
  const name = (body.name ?? '').trim().slice(0, 60) || 'Gast';
  const msg = postMessage({
    subchatId: sc.id,
    workspaceId: sc.workspaceId,
    authorKind: 'external',
    authorId: null,
    authorName: name,
    content,
    attachments,
  });
  return NextResponse.json({ message: serialize(msg) }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
}
