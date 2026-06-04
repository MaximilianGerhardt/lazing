/**
 * GET  /api/workspaces/[id]/fs-roots — list of this workspace's directories/repos.
 * POST /api/workspaces/[id]/fs-roots — { absPath, access?, role? } adds a root.
 *
 * Workspace isolation model (FS-1, design doc §4.1): a workspace is a
 * set of FS roots (multi-repo: CRM Git + website Git = ONE project), NOT
 * a single Git repo. This route populates `workspace_fs_roots` via the
 * repo module `@/lib/workspaces/fs-roots` (built by a parallel agent).
 *
 * Auth: only owner/member of the workspace (≥ member, analogous to credentials/route.ts).
 * `is_git` is detected best-effort from <absPath>/.git (fs.existsSync), default 1.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
// CONTRACT — the repo is built by a parallel agent; signatures are fixed (FS-1).
import {
  addWorkspaceRoot,
  listWorkspaceRoots,
  type FsRoot,
} from '@/lib/workspaces/fs-roots';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId } = await ctx.params;
  if (!isValidWorkspaceId(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  try {
    const db = getDb();
    // The fs-roots repo takes a better-sqlite3 Database directly → db.$raw.
    const roots: FsRoot[] = listWorkspaceRoots(db.$raw, wsId);
    return NextResponse.json({ roots });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'read_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

interface PostBody {
  absPath?: unknown;
  access?: unknown;
  role?: unknown;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId } = await ctx.params;
  if (!isValidWorkspaceId(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const absPath = typeof body.absPath === 'string' ? body.absPath.trim() : '';
  // absPath MUST be absolute (starts with '/'). No '..' escalation.
  if (!absPath.startsWith('/') || absPath.includes('..') || absPath.length > 4096) {
    return NextResponse.json(
      {
        error: 'invalid_path',
        message: 'absPath muss ein absoluter Pfad sein (beginnt mit "/", kein "..").',
      },
      { status: 400 },
    );
  }

  const access: 'ro' | 'rw' = body.access === 'ro' ? 'ro' : 'rw';
  // role: only accept 'repo' | 'dir' — 'primary' is NEVER set via the API
  // (that is the mirrored workspaces.path root, FS-1).
  const role: 'repo' | 'dir' = body.role === 'dir' ? 'dir' : 'repo';

  // is_git best-effort: if <absPath>/.git exists → Git repo. Default 1 when
  // unclear (doc §4.1: "default 1").
  let isGit = true;
  try {
    isGit = existsSync(join(absPath, '.git'));
  } catch {
    isGit = true; // unclear → default 1.
  }

  try {
    const db = getDb();
    const root: FsRoot = addWorkspaceRoot(db.$raw, {
      workspaceId: wsId,
      absPath,
      role,
      access,
      isGit,
    });
    return NextResponse.json({ root }, { status: 201 });
  } catch (err) {
    // UNIQUE(workspace_id, abs_path) violation → 409 instead of 500.
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|constraint/i.test(msg)) {
      return NextResponse.json(
        { error: 'duplicate_path', message: 'Dieser Pfad ist bereits hinzugefügt.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'write_failed', message: msg }, { status: 500 });
  }
}
