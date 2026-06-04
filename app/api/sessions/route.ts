/**
 * GET  /api/sessions  — list all Claude-Code sessions on disk
 *
 * Returns all `~/.claude/projects/*.jsonl` as session summaries.
 * Merged with the claude_sessions table (active flag).
 *
 * Query:
 *   ?workspaceId=<id>   filter to one workspace
 *   ?limit=<n>          default 100
 *
 * Bridge-capable: when LAZYOS_WEB_URL is set, it is proxied. Otherwise local.
 */

import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';
import {
  listClaudeSessions,
  readActiveSessionMap,
  type ClaudeSessionSummary,
} from '@/lib/sessions/registry';
import { bridgeOrLocal } from '@/lib/vps-bridge/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readLocal(req: Request): Response {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId') ?? undefined;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, parseInt(limitRaw, 10) || 100)) : 100;

  let sessions: ClaudeSessionSummary[] = [];
  try {
    sessions = listClaudeSessions({ workspaceId, limit });
  } catch (err) {
    return NextResponse.json(
      { error: 'sessions_scan_failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Merge with active-map from claude_sessions
  let activeMap: Record<string, string> = {};
  try {
    const db = getDb();
    activeMap = readActiveSessionMap({
      prepare: (sql: string) => ({
        all: () => db.$raw.prepare(sql).all() as Array<{ workspace_id: string; session_id: string }>,
      }),
    });
  } catch {
    // non-fatal — active flag just wont be set
  }

  const merged = sessions.map((s) => ({
    ...s,
    active: s.workspaceId ? activeMap[s.workspaceId] === s.uuid : false,
  }));

  return NextResponse.json(
    { sessions: merged, source: 'db' },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function GET(req: Request): Promise<Response> {
  return bridgeOrLocal<{ sessions: Array<ClaudeSessionSummary & { active?: boolean }>; source?: string }>({
    path: `/api/sessions${new URL(req.url).search}`,
    fallback: () => readLocal(req),
    validate: (body): body is { sessions: Array<ClaudeSessionSummary & { active?: boolean }>; source?: string } => {
      if (!body || typeof body !== 'object') return false;
      return Array.isArray((body as { sessions?: unknown }).sessions);
    },
  });
}
