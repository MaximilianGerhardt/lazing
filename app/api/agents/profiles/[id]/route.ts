/**
 * DELETE /api/agents/profiles/[id] — archive an employee profile (soft delete).
 *
 * Auth: logged in; for workspace scope additionally membership.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { archiveAgentProfile, getAgentProfile } from '@/lib/agents/profiles-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^AGP-[A-Za-z0-9]{1,40}$/.test(id)) {
    return NextResponse.json({ error: 'invalid-id' }, { status: 400 });
  }
  const profile = getAgentProfile(id);
  if (!profile) return NextResponse.json({ error: 'not-found' }, { status: 404 });
  // Workspace-scoped profile → membership required.
  if (profile.workspaceId) {
    const role = getEffectiveWorkspaceRole(userId, profile.workspaceId);
    if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, profile.workspaceId)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
  }
  const ok = archiveAgentProfile(id);
  return NextResponse.json({ archived: ok }, { status: ok ? 200 : 409 });
}
