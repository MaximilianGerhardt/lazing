/**
 * GET /api/subchats/activity
 *
 * AGGREGAT über alle Workspaces, auf die der eingeloggte User Zugriff hat —
 * Grundlage für die proaktive Sub-Chat-Karte im zentralen Hauptchat
 * (Gathering-Intelligence in den Hauptchat holen, 2026-06-02).
 *
 * Der Hauptchat sitzt i.d.R. auf dem Org-Root (virtueller Workspace), die
 * Kundenchats hängen an realen Kunden-Workspaces. Deshalb darf die Karte NICHT
 * an „current workspace" hängen, sondern aggregiert workspace-übergreifend —
 * jede Zeile trägt ihren Workspace (Kunde) als Kontext. Jeder Workspace wird
 * einzeln member-gegated (N2/N9 bleibt gewahrt).
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
        continue; // kein Zugriff → überspringen (fail-closed)
      }
      // viewerUserId → unreadCount pro Sub-Chat (Unread-Badges im Hauptchat/Drawer).
      for (const a of getSubchatActivity(ws, userId)) {
        out.push({ ...a, workspaceId: ws, workspaceLabel: labels[ws] ?? ws });
      }
    }
    // Jüngste externe Aktivität zuerst (nulls ans Ende).
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
