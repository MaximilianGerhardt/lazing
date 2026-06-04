/**
 * DELETE /api/workspaces/[id]/credentials/[credId]
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string; credId: string }>;
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  // Auth-Gate: DELETE löscht Credentials → mindestens member.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId, credId } = await ctx.params;
  if (!/^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }
  if (!/^cred-[a-zA-Z0-9-]+$/.test(credId)) {
    return NextResponse.json({ error: 'invalid_cred_id' }, { status: 400 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const db = getDb();
    const result = db.$raw
      .prepare(
        'DELETE FROM workspace_credentials WHERE id = ? AND workspace_id = ?',
      )
      .run(credId, wsId);
    if (result.changes === 0) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'delete_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
