/**
 * POST /api/sessions/[uuid]/resume
 *
 * Marks the chosen Claude Code session as the active session of the
 * current workspace in the claude_sessions table. On the next
 * /chat request the agent then spawns `claude --resume=<uuid>` instead of
 * a new session UUID.
 *
 * Body: { workspaceId }
 *
 * Auth: cookie-session OR bridge/agent bearer.
 */

import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ResumeBody {
  workspaceId?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ uuid: string }> },
): Promise<Response> {
  const { uuid } = await params;
  if (!uuid || !/^[a-f0-9-]{20,}$/i.test(uuid)) {
    return NextResponse.json({ error: 'invalid_uuid' }, { status: 400 });
  }

  let body: ResumeBody;
  try {
    body = (await req.json()) as ResumeBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;
  // Accept real workspace IDs (slug-style) AND pseudo workspaces:
  //   __root__       cross-workspace mode
  //   (root) (tmp)…  sessions started under /root or /tmp that
  //                  are reported as virtual workspaces by the
  //                  registry scanner.
  const isValid =
    typeof workspaceId === 'string' &&
    workspaceId.length > 0 &&
    workspaceId.length <= 64 &&
    /^[a-z0-9_()][a-z0-9_()-]{0,63}$/i.test(workspaceId);
  if (!isValid) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  try {
    const db = getDb();
    const now = Date.now();
    // claude_sessions schema (migration 0006): workspace_id PK, session_id,
    // last_prompt_at NOT NULL, turn_count, last_result, created_at, updated_at
    db.$raw
      .prepare(
        `INSERT INTO claude_sessions (workspace_id, session_id, last_prompt_at, turn_count, last_result, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'resumed', ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           session_id = excluded.session_id,
           last_prompt_at = excluded.last_prompt_at,
           last_result = 'resumed',
           updated_at = excluded.updated_at`,
      )
      .run(workspaceId, uuid, now, now, now);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'db_write_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    workspaceId,
    sessionId: uuid,
  });
}
