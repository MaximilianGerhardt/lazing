/**
 * POST /api/workspaces/[id]/bridges — owner grants a cross-scope grant.
 *
 * Workspace isolation model (FS-5, design doc §4.3): a cross-scope grant
 * is NOT a new mechanism — it is a `bridges` row (N9 unification):
 *   from_coord = {kind:'workspace', id:<this-workspace>}
 *   to_coord   = {kind:'project',  path:<toPath>}        // another folder
 *           OR  {kind:'workspace', id:<toWorkspaceId>}   // a whole workspace
 *
 * Body: { toPath?, toWorkspaceId?, access:'ro'|'rw', expiresAt? }
 *
 * SCOPE of this route: write ONLY the bridge row. The audit row
 * (workstream_cross_workspace_audit) + the sandbox-profile effect is done by the
 * integrator (FS-5). The `access` value + any revoke logic land in the
 * dsgvo_metadata_jsonb, because the `bridges` schema (0076) has no own
 * access column.
 *
 * Auth: owner grant → ≥ admin (canManageWorkspaceStructure). Granting cross-scope
 * rights is a structure operation, not a mere content write.
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

// Default lifetime when no expiresAt is passed: 30 days (temporary,
// not "permanent" — the owner can extend by creating a new bridge;
// 0076 only allows expires_at to be REDUCED, never increased).
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Upper bound: ~10 years (de-facto "permanent" without encoding FOREVER).
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

  // Owner grant: granting cross-scope rights → ≥ admin.
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

  // Exactly ONE of toPath / toWorkspaceId.
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
  // CHECK (expires_at > approved_at) in the schema — clamp instead of risking a 500.
  if (expiresAt <= now) expiresAt = now + DEFAULT_TTL_MS;
  if (expiresAt > now + MAX_TTL_MS) expiresAt = now + MAX_TTL_MS;

  const fromCoord = JSON.stringify({ kind: 'workspace', id: wsId });
  const toCoord = toPath
    ? JSON.stringify({ kind: 'project', path: toPath })
    : JSON.stringify({ kind: 'workspace', id: toWorkspaceId });

  // CHECK (from_coord <> to_coord) — reject self-bridge.
  if (fromCoord === toCoord) {
    return NextResponse.json(
      { error: 'self_bridge', message: 'Ein Workspace kann sich nicht selbst bridgen.' },
      { status: 400 },
    );
  }

  // access is carried in the GDPR metadata blob (no dedicated schema field in 0076).
  const dsgvoMetadata = JSON.stringify({
    art30_purpose: 'cross-scope-fs-grant',
    access,
    granted_by: userId,
    granted_at: now,
    target: toPath ? { kind: 'project', path: toPath } : { kind: 'workspace', id: toWorkspaceId },
  });

  try {
    const db = getDb();
    const id = ulid(now); // length(id) = 26 (schema CHECK).
    // integrator: verify against bridges repo if one exists (FS-5).
    // Writes ONLY the bridge row. Audit row + sandbox effect = integrator.
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
