/**
 * POST /api/subchats/[subchatId]/questions/[questionId]/answer
 *   Body: { optionId?: string, freeText?: string, answerName?: string }
 *   Beantwortet eine angespinnte Frage (Option ODER Freitext). Ingestet in RAG.
 *
 * Question-Spinning Slice 1 (2026-06-03). Auth: Member des Workspace.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat } from '@/lib/subchats/service';
import { answerQuestion } from '@/lib/subchats/questions-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ subchatId: string; questionId: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId, questionId } = await ctx.params;
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) {
    return NextResponse.json({ error: 'invalid_subchat_id' }, { status: 400 });
  }
  if (!/^SCQ-[A-Za-z0-9]{1,40}$/.test(questionId)) {
    return NextResponse.json({ error: 'invalid_question_id' }, { status: 400 });
  }
  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: { optionId?: string; freeText?: string; answerName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid-json' }, { status: 400 });
  }
  const optionId = typeof body.optionId === 'string' ? body.optionId : null;
  const freeText = typeof body.freeText === 'string' ? body.freeText.trim() : null;
  // Genau eines muss gesetzt sein.
  if ((!optionId && !freeText) || (optionId && freeText)) {
    return NextResponse.json({ error: 'need-option-or-freetext' }, { status: 400 });
  }
  if (freeText && freeText.length > 8000) {
    return NextResponse.json({ error: 'freetext-too-long' }, { status: 400 });
  }

  const answer = answerQuestion({
    questionId,
    subchatId,
    workspaceId: sc.workspaceId,
    answererKind: 'internal',
    answererId: userId,
    answererName: body.answerName?.trim() || 'Team',
    optionId,
    freeText,
  });

  return NextResponse.json(
    { answer: { id: answer.id, optionId: answer.optionId, freeText: answer.freeText, createdAt: answer.createdAt } },
    { status: 201, headers: { 'Cache-Control': 'no-store' } },
  );
}
