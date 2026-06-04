/**
 * GET /api/bugs/swarm/[id]
 * ------------------------
 * Sprint H · 2026-04-30 — polling endpoint for the BugFixSwarmCard.
 *
 * Lookup: the workstream where `iterate_config_json.bug_swarm.swarmId == [id]`.
 * Returns the state snapshot directly from the DB (= from runBugSwarm-writeState).
 *
 * Response = the `BugSwarmState` shape (see server/agents/bug-swarm.ts), or
 * `{ phase: 'diagnose', diagnoses: [pending, pending, pending], ... }` as an
 * initial stub if the run has not yet begun to write.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import type { BugSwarmState } from '@/server/agents/bug-swarm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Row {
  id: string;
  iterate_config_json: string | null;
}

export async function GET(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id: swarmId } = await ctx.params;

  if (!swarmId || swarmId.length === 0 || swarmId.length > 128) {
    return NextResponse.json({ error: 'invalid_swarm_id' }, { status: 400 });
  }

  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT id, iterate_config_json
         FROM workstreams
        WHERE json_extract(iterate_config_json, '$.bug_swarm.swarmId') = ?
        LIMIT 1`,
    )
    .get(swarmId) as Row | undefined;

  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  let state: BugSwarmState | null = null;
  try {
    const parsed = JSON.parse(row.iterate_config_json ?? '{}') as Record<
      string,
      unknown
    >;
    if (parsed.bug_swarm && typeof parsed.bug_swarm === 'object') {
      state = parsed.bug_swarm as BugSwarmState;
    }
  } catch {
    /* malformed — fall through to 404 */
  }

  if (!state) {
    return NextResponse.json({ error: 'state_missing' }, { status: 404 });
  }

  return NextResponse.json(state);
}
