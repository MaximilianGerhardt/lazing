/**
 * POST /api/subchats/[subchatId]/questions/suggest-ai
 *   → { suggestions: [{text, options}] }  (KI schlägt Rückfragen vor; NICHT gespinnt)
 *
 * KI-auto-anspinnen (2026-06-03). Auth: Workspace-Member.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat } from '@/lib/subchats/service';
import { suggestQuestionsForSubchat } from '@/lib/subchats/questions-suggest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ subchatId: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { subchatId } = await ctx.params;
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) {
    return NextResponse.json({ error: 'invalid_subchat_id' }, { status: 400 });
  }
  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ error: 'subchat_not_found' }, { status: 404 });
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const suggestions = await suggestQuestionsForSubchat(subchatId, sc.workspaceId);
  return NextResponse.json({ suggestions }, { headers: { 'Cache-Control': 'no-store' } });
}
