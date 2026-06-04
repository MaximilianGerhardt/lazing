/**
 * DELETE /api/workspaces/[id]/fs-roots/[rootId] — entfernt einen FS-Root.
 * PATCH  /api/workspaces/[id]/fs-roots/[rootId] — { access:'ro'|'rw' } toggelt
 *        die Zugriffspolitik eines FS-Roots (sauberer Toggle statt Re-POST).
 *
 * Der Primary-Root (gespiegelter workspaces.path) wird NICHT über DELETE
 * gelöscht — der Editor blendet den Remove-Button dafür aus, und das Repo-Modul
 * (FS-1) lehnt den Versuch zusätzlich ab (defense-in-depth → 409).
 *
 * Auth: ≥ member (analog credentials/[credId]/route.ts).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
// CONTRACT — Repo baut ein paralleler Agent (FS-1).
import {
  removeWorkspaceRoot,
  updateWorkspaceRootAccess,
  type FsRoot,
} from '@/lib/workspaces/fs-roots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string; rootId: string }>;
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId, rootId } = await ctx.params;
  if (!/^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rootId)) {
    return NextResponse.json({ error: 'invalid_root_id' }, { status: 400 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const db = getDb();
    // fs-roots-Repo nimmt eine better-sqlite3-Database direkt → db.$raw.
    const result = removeWorkspaceRoot(db.$raw, rootId);

    // Defense-in-depth (FS-1): das Repo lehnt Primary-Root-Löschung ab.
    if (!result.removed && result.reason === 'primary_protected') {
      return NextResponse.json(
        { error: 'primary_protected', message: 'Der primäre Ordner kann nicht entfernt werden.' },
        { status: 409 },
      );
    }
    if (!result.removed && result.reason === 'not_found') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'delete_failed', message: msg }, { status: 500 });
  }
}

interface PatchBody {
  access?: unknown;
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId, rootId } = await ctx.params;
  if (!/^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rootId)) {
    return NextResponse.json({ error: 'invalid_root_id' }, { status: 400 });
  }

  // Auth identisch zur DELETE-Route (≥ member des Workspace).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (body.access !== 'ro' && body.access !== 'rw') {
    return NextResponse.json(
      { error: 'invalid_access', message: "access muss 'ro' oder 'rw' sein." },
      { status: 400 },
    );
  }
  const access: 'ro' | 'rw' = body.access;

  try {
    const db = getDb();
    // fs-roots-Repo nimmt eine better-sqlite3-Database direkt → db.$raw.
    const root: FsRoot | null = updateWorkspaceRootAccess(db.$raw, rootId, access);
    if (!root) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ root });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: 'update_failed', message: msg }, { status: 500 });
  }
}
