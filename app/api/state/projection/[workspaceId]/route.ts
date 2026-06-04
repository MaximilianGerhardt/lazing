/**
 * GET /api/state/projection/[workspaceId]
 *
 * Phase 1 Track E (2026-05-29) — State-Projection-Spine.
 *
 * Returns the deterministic operational state of a workspace from the
 * DB/event truth. Counterpart to Finding D Handoff §10: "There must be a
 * State Projection from DB/event state […]; visible historical
 * chat surfaces must not be the source of truth."
 *
 * Output contract: lib/projection/types.ts → WorkspaceState (see there
 * for full docs — what the fields mean, what they don't).
 *
 * ── Auth gate ────────────────────────────────────────────────────────────
 *   Identical to /api/permission/[workspaceId]/mode (see permissions.ts):
 *   (A) currentUserIdResolved        → 401 if not logged in.
 *   (B) canEditWorkspaceContent      → 403 if < member.
 *   (C) hasRealWorkspaceMembership   → 403 (IDOR hardening, no
 *       solo-implicit-founder trust for sensitive operational state reads).
 *
 * ── Cache discipline ─────────────────────────────────────────────────────
 *   Cache-Control: no-store, must-revalidate.
 *   The projection is by definition time-sensitive (e.g. a just-answered
 *   question entry must come back as answered=true IMMEDIATELY).
 *   force-dynamic enforces this even in Vercel edge cache strategies.
 *
 * ── Latency budget ───────────────────────────────────────────────────────
 *   <100ms for realistic workspace load. The performance smoke in the test
 *   checks the function directly; the route only adds auth + JSON serialization.
 *
 * ── Read-only ────────────────────────────────────────────────────────────
 *   This route NEVER writes. No audit row, no state mutation. Pure
 *   read-only projection.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { projectWorkspaceState } from '@/lib/projection/state-projector';
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { hasRealWorkspaceMembership } from '@/lib/security/membership';
import { currentUserIdResolved } from '@/lib/security/subject-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ workspaceId: string }>;
}

// Conservative format guard on workspaceId (mirrored from
// /api/permission/[workspaceId]/mode + /api/connectors/invoke). Prevents
// control/overlong values from landing in DB queries or logs.
const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;

  // ── 1. Format guard ──────────────────────────────────────────────────────
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── 2. Auth gate ─────────────────────────────────────────────────────────
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'auth-required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // ── 3. Projection ────────────────────────────────────────────────────────
  // projectWorkspaceState is internally fail-soft — never throws. We still
  // wrap defensively (defense-in-depth) so that an unexpected DB error
  // (e.g. corrupt schema) does not crash the route handler.
  try {
    const db = getDb();
    const state = projectWorkspaceState(db.$raw, workspaceId);
    return NextResponse.json(state, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, must-revalidate',
      },
    });
  } catch (err) {
    console.error('[state/projection GET] unexpected error:', err);
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
