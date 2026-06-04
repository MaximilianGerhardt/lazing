/**
 * GET /api/subchats/activity
 *
 * AGGREGATE across all workspaces the logged-in user has access to —
 * the basis for the proactive sub-chat card in the central main chat
 * (pulling gathering-intelligence into the main chat, 2026-06-02).
 *
 * The main chat usually sits on the org root (virtual workspace), while the
 * customer chats hang off real customer workspaces. Therefore the card must NOT
 * be tied to the "current workspace" but aggregates across workspaces —
 * each row carries its workspace (customer) as context. Each workspace is
 * member-gated individually (N2/N9 stays preserved).
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchatActivity, listSubchatWorkspaceIds } from '@/lib/subchats/service';
import { workspaceLabels } from '@/lib/workspaces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  try {
    const wsIds = listSubchatWorkspaceIds();
    const labels = await workspaceLabels();
    const out: Array<Record<string, unknown>> = [];
    for (const ws of wsIds) {
      const role = getEffectiveWorkspaceRole(userId, ws);
      if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, ws)) {
        continue; // no access → skip (fail-closed)
      }
      // viewerUserId → unreadCount per sub-chat (unread badges in main chat/drawer).
      for (const a of getSubchatActivity(ws, userId)) {
        out.push({ ...a, workspaceId: ws, workspaceLabel: labels[ws] ?? ws });
      }
    }
    // Most recent external activity first (nulls to the end).
    out.sort(
      (a, b) =>
        ((b.lastExternalTs as number | null) ?? 0) -
        ((a.lastExternalTs as number | null) ?? 0),
    );
    return NextResponse.json({ activity: out }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[subchats activity aggregate GET]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
