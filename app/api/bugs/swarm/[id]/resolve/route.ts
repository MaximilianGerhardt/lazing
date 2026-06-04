/**
 * POST /api/bugs/swarm/[id]/resolve
 * ----------------------------------
 * Sprint H · 2026-04-30 — user choice on disagreement.
 *
 * Body: { chosenHypothesisId: 'senior-dev' | 'code-reviewer' | 'critic' }
 *
 * On disagreement the BugFixSwarmCard shows 3 QuickChoice buttons. The
 * `id` of each button is the role that proposed that hypothesis.
 * On click the frontend calls this endpoint, which then
 * starts resumeBugSwarmWithChoice() in the background.
 *
 * Response: `{ ok: true }` — async, the frontend polls /api/bugs/swarm/[id].
 */

import fs from 'node:fs';

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { getWorkspace } from '@/lib/workspaces';
import { defaultWorkspacePath, projectsRoot } from '@/lib/workspaces/projects-root';
import {
  resumeBugSwarmWithChoice,
  type BugSwarmRole,
} from '@/server/agents/bug-swarm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z
  .object({
    chosenHypothesisId: z.enum(['senior-dev', 'code-reviewer', 'critic']),
  })
  .strict();

interface Ctx {
  params: Promise<{ id: string }>;
}

interface Row {
  id: string;
  workspace_id: string;
  iterate_config_json: string | null;
}

async function resolveWorkspacePath(workspaceId: string): Promise<string> {
  if (workspaceId === '__root__') return projectsRoot();
  const ws = await getWorkspace(workspaceId).catch(() => null);
  if (ws && typeof ws.path === 'string' && fs.existsSync(ws.path)) return ws.path;
  const guess = defaultWorkspacePath(workspaceId);
  if (fs.existsSync(guess)) return guess;
  return projectsRoot();
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id: swarmId } = await ctx.params;
  if (!swarmId || swarmId.length > 128) {
    return NextResponse.json({ error: 'invalid_swarm_id' }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT id, workspace_id, iterate_config_json
         FROM workstreams
        WHERE json_extract(iterate_config_json, '$.bug_swarm.swarmId') = ?
        LIMIT 1`,
    )
    .get(swarmId) as Row | undefined;

  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const workspacePath = await resolveWorkspacePath(row.workspace_id);
  const choice: BugSwarmRole = parsed.data.chosenHypothesisId;

  // Background run — return immediately.
  void resumeBugSwarmWithChoice(row.id, choice, workspacePath).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[bug-swarm] resume crashed:', err);
  });

  return NextResponse.json({ ok: true });
}
