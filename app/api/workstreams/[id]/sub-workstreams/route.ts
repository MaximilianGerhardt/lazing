/**
 * GET /api/workstreams/[id]/sub-workstreams
 *
 * Sprint C (2026-04-29). Liefert Liste aller direkten Sub-Workstreams
 * unter einem Master + Aggregat-Totals fuer die Card-Header-Zeile.
 *
 * Auth: User muss eingeloggt UND viewer im Workspace des Masters sein.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface MasterRow {
  workspace_id: string;
  status: string;
}

interface SubRow {
  id: string;
  parent_workstream_id: string | null;
  role: string | null;
  name: string;
  status: string;
  tmux_session_id: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_cents_aggregated: number;
  created_at: number;
  updated_at: number;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: masterId } = await params;

  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const db = getDb();
  const master = db.$raw
    .prepare(
      'SELECT workspace_id, status FROM workstreams WHERE id = ?',
    )
    .get(masterId) as MasterRow | undefined;
  if (!master) {
    return NextResponse.json({ error: 'not-found' }, { status: 404 });
  }
  if (
    !canReadWorkspace(getEffectiveWorkspaceRole(userId, master.workspace_id))
  ) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const rows = db.$raw
    .prepare(
      `SELECT id, parent_workstream_id, role, name, status,
              tmux_session_id, tokens_in, tokens_out, cost_cents_aggregated,
              created_at, updated_at
         FROM workstreams
        WHERE parent_workstream_id = ?
        ORDER BY created_at ASC`,
    )
    .all(masterId) as SubRow[];

  let totalIn = 0;
  let totalOut = 0;
  let totalCost = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const r of rows) {
    totalIn += r.tokens_in ?? 0;
    totalOut += r.tokens_out ?? 0;
    totalCost += r.cost_cents_aggregated ?? 0;
    if (r.status === 'done') done += 1;
    // P1-6: 'stuck' (Resume-Spawn leer / haengen geblieben) als failed
    // zaehlen, damit Card-Header + Polling-Backoff korrekt reagieren.
    else if (r.status === 'paused' || r.status === 'stuck') failed += 1;
    else if (r.status === 'active') {
      // Heuristik: aktiv + tokens > 0 = running, sonst pending.
      if ((r.tokens_in ?? 0) + (r.tokens_out ?? 0) > 0) running += 1;
    }
  }

  return NextResponse.json(
    {
      parentId: masterId,
      subs: rows.map((r) => ({
        id: r.id,
        parentWorkstreamId: r.parent_workstream_id,
        role: r.role,
        name: r.name,
        status: r.status,
        tmuxSessionId: r.tmux_session_id,
        tokensIn: r.tokens_in ?? 0,
        tokensOut: r.tokens_out ?? 0,
        costCentsAggregated: r.cost_cents_aggregated ?? 0,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      totals: {
        tokensIn: totalIn,
        tokensOut: totalOut,
        costCents: totalCost,
        running,
        done,
        failed,
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
