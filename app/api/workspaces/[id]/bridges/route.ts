/**
 * POST /api/workspaces/[id]/bridges — Owner gewährt einen Cross-Scope-Grant.
 *
 * Workspace-Isolations-Modell (FS-5, Design-Doc §4.3): ein Cross-Scope-Grant
 * ist KEIN neuer Mechanismus — es ist eine `bridges`-Row (N9-Unifikation):
 *   from_coord = {kind:'workspace', id:<this-workspace>}
 *   to_coord   = {kind:'project',  path:<toPath>}        // ein anderer Ordner
 *           ODER {kind:'workspace', id:<toWorkspaceId>}  // eine ganze Workspace
 *
 * Body: { toPath?, toWorkspaceId?, access:'ro'|'rw', expiresAt? }
 *
 * SCOPE dieser Route: NUR die Bridge-Row schreiben. Die Audit-Row
 * (workstream_cross_workspace_audit) + die Sandbox-Profil-Wirkung macht der
 * Integrator (FS-5). Die `access`-Angabe + ggf. Revoke-Logik landen im
 * dsgvo_metadata_jsonb, weil das `bridges`-Schema (0076) keine eigene
 * access-Spalte hat.
 *
 * Auth: Owner-Grant → ≥ admin (canManageWorkspaceStructure). Cross-Scope-Rechte
 * zu vergeben ist eine Struktur-Operation, kein bloßer Content-Write.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canManageWorkspaceStructure,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { ulid } from '@/lib/ulid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

interface PostBody {
  toPath?: unknown;
  toWorkspaceId?: unknown;
  access?: unknown;
  expiresAt?: unknown;
}

// Default-Lebensdauer wenn kein expiresAt übergeben wird: 30 Tage (temporär,
// nicht "permanent" — der Owner kann verlängern indem er eine neue Bridge anlegt;
// 0076 erlaubt expires_at nur zu REDUZIEREN, nie zu erhöhen).
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Obergrenze: ~10 Jahre (de-facto "permanent" ohne FOREVER zu codieren).
const MAX_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { id: wsId } = await ctx.params;
  if (!isValidWorkspaceId(wsId)) {
    return NextResponse.json({ error: 'invalid_workspace_id' }, { status: 400 });
  }

  // Owner-Grant: Cross-Scope-Rechte vergeben → ≥ admin.
  if (!canManageWorkspaceStructure(getEffectiveWorkspaceRole(userId, wsId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const toPath =
    typeof body.toPath === 'string' && body.toPath.trim().length > 0
      ? body.toPath.trim()
      : null;
  const toWorkspaceId =
    typeof body.toWorkspaceId === 'string' && body.toWorkspaceId.trim().length > 0
      ? body.toWorkspaceId.trim()
      : null;
  const access: 'ro' | 'rw' = body.access === 'rw' ? 'rw' : 'ro';

  // Genau EINES von toPath / toWorkspaceId.
  if ((toPath && toWorkspaceId) || (!toPath && !toWorkspaceId)) {
    return NextResponse.json(
      {
        error: 'invalid_target',
        message: 'Gib genau ein Ziel an: toPath ODER toWorkspaceId.',
      },
      { status: 400 },
    );
  }
  if (toPath && (!toPath.startsWith('/') || toPath.includes('..') || toPath.length > 4096)) {
    return NextResponse.json(
      { error: 'invalid_path', message: 'toPath muss ein absoluter Pfad sein (kein "..").' },
      { status: 400 },
    );
  }
  if (toWorkspaceId && !isValidWorkspaceId(toWorkspaceId)) {
    return NextResponse.json({ error: 'invalid_to_workspace_id' }, { status: 400 });
  }

  const now = Date.now();
  let expiresAt: number;
  if (typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)) {
    expiresAt = Math.floor(body.expiresAt);
  } else {
    expiresAt = now + DEFAULT_TTL_MS;
  }
  // CHECK (expires_at > approved_at) im Schema — clampen statt 500 riskieren.
  if (expiresAt <= now) expiresAt = now + DEFAULT_TTL_MS;
  if (expiresAt > now + MAX_TTL_MS) expiresAt = now + MAX_TTL_MS;

  const fromCoord = JSON.stringify({ kind: 'workspace', id: wsId });
  const toCoord = toPath
    ? JSON.stringify({ kind: 'project', path: toPath })
    : JSON.stringify({ kind: 'workspace', id: toWorkspaceId });

  // CHECK (from_coord <> to_coord) — Selbst-Bridge ablehnen.
  if (fromCoord === toCoord) {
    return NextResponse.json(
      { error: 'self_bridge', message: 'Ein Workspace kann sich nicht selbst bridgen.' },
      { status: 400 },
    );
  }

  // access wird im DSGVO-Metadata-Blob mitgeführt (kein eigenes Schema-Feld in 0076).
  const dsgvoMetadata = JSON.stringify({
    art30_purpose: 'cross-scope-fs-grant',
    access,
    granted_by: userId,
    granted_at: now,
    target: toPath ? { kind: 'project', path: toPath } : { kind: 'workspace', id: toWorkspaceId },
  });

  try {
    const db = getDb();
    const id = ulid(now); // length(id) = 26 (Schema-CHECK).
    // integrator: verify against bridges repo if one exists (FS-5).
    // Schreibt NUR die Bridge-Row. Audit-Row + Sandbox-Wirkung = Integrator.
    db.$raw
      .prepare(
        `INSERT INTO bridges
           (id, from_coord, to_coord, approved_by, approved_at, expires_at, dsgvo_metadata_jsonb, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, fromCoord, toCoord, userId, now, expiresAt, dsgvoMetadata, now);

    return NextResponse.json(
      {
        bridge: {
          id,
          fromWorkspaceId: wsId,
          toPath,
          toWorkspaceId,
          access,
          approvedBy: userId,
          approvedAt: now,
          expiresAt,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: 'write_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
