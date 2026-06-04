/**
 * GET  /api/subchats/external/[token]  — Sub-Chat über Share-Token auflösen
 *                                        (öffentlich, KEIN Login) + Nachrichten.
 * POST /api/subchats/external/[token]  — als externer Gast posten (Name + Text).
 *
 * Der Token IST die Autorisierung (gehasht in der DB). Externe sehen NIE die
 * KI. Jede Nachricht fließt in die Workspace-RAG (via postMessage → ingest).
 * Public-Route — in middleware.ts unter PUBLIC_PREFIXES `/api/subchats/external/`.
 *
 * Gathering-Intelligence-Goal (2026-06-02).
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
  // Nur das, was ein externer Gast sehen darf — KEINE internen IDs/Token.
  return NextResponse.json(
    {
      subchat: { id: sc.id, title: sc.title },
      messages,
      // dezenter Transparenz-Hinweis (DSGVO/Trust, vom Owner bestätigt).
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
