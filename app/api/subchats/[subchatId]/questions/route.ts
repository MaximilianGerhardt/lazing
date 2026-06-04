/**
 * GET  /api/subchats/[subchatId]/questions  — read questions + options + answers.
 * POST /api/subchats/[subchatId]/questions  — spin up a question (internal, member).
 *
 * Question-Spinning Slice 1 (2026-06-03). Auth: member of the workspace.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat } from '@/lib/subchats/service';
import {
  listQuestionViews,
  spinQuestion,
  type QuestionView,
} from '@/lib/subchats/questions-service';

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

function serialize(v: QuestionView) {
  return {
    id: v.question.id,
    text: v.question.text,
    authorKind: v.question.authorKind,
    authorName: v.question.authorName,
    seq: v.question.seq,
    status: v.question.status,
    createdAt: v.question.createdAt,
    options: v.options.map((o) => ({ id: o.id, label: o.label, seq: o.seq })),
    answers: v.answers.map((a) => ({
      id: a.id,
      answererKind: a.answererKind,
      answererId: a.answererId,
      answererName: a.answererName,
      optionId: a.optionId,
      freeText: a.freeText,
      createdAt: a.createdAt,
    })),
  };
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  const questions = listQuestionViews(subchatId).map(serialize);
  return NextResponse.json(
    { subchatId, viewerId: g.userId, questions },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  const g = await resolveAndGate(req, subchatId);
  if (!g.ok) return g.res;
  let body: { text?: string; options?: unknown; authorName?: string; aiAuthored?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const text = (body.text ?? '').trim();
  if (text.length < 1 || text.length > 2000) {
    return NextResponse.json({ error: 'invalid-text' }, { status: 400 });
  }
  const options = Array.isArray(body.options)
    ? body.options.filter((o): o is string => typeof o === 'string')
    : [];
  // AI auto-spin: operator-approved AI suggestion → marked as 'ai'
  // (the AI asks), but triggered by the operator (no auto-send).
  const aiAuthored = body.aiAuthored === true;
  const { question, options: opts } = spinQuestion({
    subchatId,
    workspaceId: g.workspaceId,
    authorKind: aiAuthored ? 'ai' : 'internal',
    authorId: aiAuthored ? null : g.userId,
    authorName: aiAuthored ? 'Assistent' : body.authorName?.trim() || 'Team',
    text,
    options,
  });
  return NextResponse.json(
    {
      question: {
        id: question.id,
        text: question.text,
        seq: question.seq,
        status: question.status,
        options: opts.map((o) => ({ id: o.id, label: o.label, seq: o.seq })),
      },
    },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
