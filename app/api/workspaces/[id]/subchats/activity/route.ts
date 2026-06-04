/**
 * GET /api/workspaces/[id]/subchats/activity
 *
 * Schlanker Activity-Snapshot für die proaktive Sub-Chat-Karte im Hauptchat
 * (Gathering-Intelligence in den Hauptchat holen, 2026-06-02). Liefert je
 * Sub-Chat letzte Nachricht (Vorschau), Zeitstempel der letzten externen
 * Nachricht und externe Gesamtzahl. shareTokenHash wird NIE ausgeliefert.
 *
 * Auth: Workspace-Member (identisch zur Sub-Chat-Liste).
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
