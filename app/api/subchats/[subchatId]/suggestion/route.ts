/**
 * GET /api/subchats/[subchatId]/suggestion — reads the PRE-generated,
 * server-side proactive suggestion for ONE sub-chat (Proactivity goal,
 * 2026-06-02). The watcher (lib/subchats/service.postMessage → lib/proactive/
 * generate) created it when the EXTERNAL message arrived. This route makes
 * NO engine calls — it only reads. Member-gated (N2/N9). NEVER
 * auto-sends: returns only text + id for the 1-tap accept flow.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { getSubchat, listProactiveSuggestionForSubchat } from '@/lib/subchats/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ subchatId: string }> },
): Promise<Response> {
  const { subchatId } = await params;
  if (!/^SC-[A-Za-z0-9]{1,40}$/.test(subchatId)) {
    return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  }

  const sc = getSubchat(subchatId);
  if (!sc) return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });

  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const role = getEffectiveWorkspaceRole(userId, sc.workspaceId);
  if (!canEditWorkspaceContent(role) || !hasRealWorkspaceMembership(userId, sc.workspaceId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const row = listProactiveSuggestionForSubchat(subchatId);
  if (!row) return NextResponse.json({ suggestion: '' }, { status: 200, headers: NO_STORE });
  return NextResponse.json(
    { suggestion: row.suggestion, suggestionId: row.id },
    { status: 200, headers: NO_STORE },
  );
}
