/**
 * POST /api/subchats/search  — sub-chat knowledge search (member, cross-workspace).
 *
 * Aggregates workspace-scoped RAG retrieve() across ALL sub-chat-bearing workspaces
 * the logged-in user has access to (each member-gated individually, fail-closed).
 * N2: one isolated retrieve() call per workspace (no cross-workspace fallback).
 * Returns ranked hits with subchat/workspace + deep link.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { listSubchatWorkspaceIds, listSubchats, listMessages } from '@/lib/subchats/service';
import { workspaceLabels } from '@/lib/workspaces';
import { retrieve } from '@/lib/rag/retriever';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  let body: { q?: unknown; limit?: unknown };
  try { body = (await req.json()) as typeof body; }
  catch { return NextResponse.json({ error: 'invalid-json' }, { status: 400 }); }

  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (q.length < 2) return NextResponse.json({ query: q, workspacesSearched: 0, results: [] });
  const limit = Math.min(
    typeof body.limit === 'number' && body.limit > 0 ? Math.floor(body.limit) : DEFAULT_LIMIT,
    MAX_LIMIT,
  );

  try {
    const wsIds = listSubchatWorkspaceIds();
    const labels = await workspaceLabels();
    const accessible = wsIds.filter((ws) => {
      const role = getEffectiveWorkspaceRole(userId, ws);
      return canEditWorkspaceContent(role) && hasRealWorkspaceMembership(userId, ws);
    });

    type Hit = {
      subchatId: string; subchatTitle: string; workspaceId: string;
      workspaceLabel: string; snippet: string; similarity: number;
      deepLink: string; messageId: string;
    };
    const all: Hit[] = [];

    for (const ws of accessible) {
      // N2: isolated per-workspace retrieve. topK generous, then global re-cap.
      const res = await retrieve({ workspaceId: ws, query: q, topK: limit });
      const subHits = res.hits.filter((h) => h.sourceType === 'subchat');
      if (subHits.length === 0) continue;

      // messageId('SCM-…') → {subchatId,title} map via existing service exports.
      const msgToSub = new Map<string, { id: string; title: string }>();
      for (const sc of listSubchats(ws)) {
        for (const m of listMessages(sc.id)) msgToSub.set(m.id, { id: sc.id, title: sc.title });
      }

      for (const h of subHits) {
        const sub = msgToSub.get(h.sourceId);
        if (!sub) continue; // chunk without a resolvable subchat (e.g. deleted) → skip
        all.push({
          subchatId: sub.id,
          subchatTitle: sub.title,
          workspaceId: ws,
          workspaceLabel: labels[ws] ?? ws,
          snippet: h.text,            // N1: verbatim, no server-side slice
          similarity: h.similarity,
          deepLink: `/workspaces/${encodeURIComponent(ws)}/subchats/${encodeURIComponent(sub.id)}`,
          messageId: h.sourceId,
        });
      }
    }

    all.sort((a, b) => b.similarity - a.similarity);
    return NextResponse.json(
      { query: q, workspacesSearched: accessible.length, results: all.slice(0, limit) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    console.error('[subchats search]', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
