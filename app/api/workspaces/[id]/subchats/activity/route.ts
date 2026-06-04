/**
 * GET /api/workspaces/[id]/subchats/activity
 *
 * Lean activity snapshot for the proactive sub-chat card in the main chat
 * (pulling gathering-intelligence into the main chat, 2026-06-02). Returns per
 * sub-chat the last message (preview), the timestamp of the last external
 * message and the external total count. shareTokenHash is NEVER served.
 *
 * Auth: workspace member (identical to the sub-chat list).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchatActivity } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!WORKSPACE_ID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  const role = getEffectiveWorkspaceRole(userId, id);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const activity = getSubchatActivity(id);
    return NextResponse.json({ activity }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[subchats activity GET]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
