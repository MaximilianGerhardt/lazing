/**
 * GET  /api/workspaces/[id]/fs-roots — Liste der Verzeichnisse/Repos dieses Workspace.
 * POST /api/workspaces/[id]/fs-roots — { absPath, access?, role? } fügt einen Root hinzu.
 *
 * Workspace-Isolations-Modell (FS-1, Design-Doc §4.1): ein Workspace ist ein
 * Satz von FS-Roots (Multi-Repo: CRM-Git + Website-Git = EIN Projekt), NICHT
 * ein einzelnes Git-Repo. Diese Route befüllt `workspace_fs_roots` über das
 * Repo-Modul `@/lib/workspaces/fs-roots` (baut ein paralleler Agent).
 *
 * Auth: nur Owner/Member des Workspace (≥ member, analog credentials/route.ts).
 * `is_git` wird best-effort aus <absPath>/.git erkannt (fs.existsSync), default 1.
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
// CONTRACT — Repo baut ein paralleler Agent; Signaturen sind fixiert (FS-1).
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
    // fs-roots-Repo nimmt eine better-sqlite3-Database direkt → db.$raw.
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
  // absPath MUSS absolut sein (beginnt mit '/'). Keine '..'-Eskalation.
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
  // role: nur 'repo' | 'dir' akzeptieren — 'primary' wird NIE über die API gesetzt
  // (das ist der gespiegelte workspaces.path-Root, FS-1).
  const role: 'repo' | 'dir' = body.role === 'dir' ? 'dir' : 'repo';

  // is_git best-effort: existiert <absPath>/.git → Git-Repo. Default 1 wenn
  // unklar (Doc §4.1: "default 1").
  let isGit = true;
  try {
    isGit = existsSync(join(absPath, '.git'));
  } catch {
    isGit = true; // unklar → default 1.
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
    // UNIQUE(workspace_id, abs_path)-Verletzung → 409 statt 500.
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
