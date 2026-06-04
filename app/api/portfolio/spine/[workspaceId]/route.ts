/**
 * GET /api/portfolio/spine/[workspaceId]
 *
 * Phase 2 W2.0 (2026-05-29) — portfolio-spine read route.
 *
 * Returns the deterministic `PortfolioRunState` of a workspace
 * (see `lib/portfolio/types.ts`). When no portfolio run exists for the
 * workspace, we return 200 + `{ portfolioRun: null }`
 * (owner: „read-only Probe, kein Fehler wenn leer").
 *
 * ── Auth gate ─────────────────────────────────────────────────────────────
 *   Mirrored from `app/api/state/projection/[workspaceId]/route.ts`:
 *   (A) currentUserIdResolved        → 401 when not logged in.
 *   (B) canEditWorkspaceContent      → 403 when < member.
 *   (C) hasRealWorkspaceMembership   → 403 (IDOR hardening).
 *
 * ── Cache discipline ──────────────────────────────────────────────────────
 *   no-store, must-revalidate. State is by definition time-sensitive —
 *   a just-merged stage must appear IMMEDIATELY in `completedMergeStages`.
 *
 * ── Read-only ─────────────────────────────────────────────────────────────
 *   This route NEVER writes. No audit row, no state mutation.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getDb } from '@/db/client';
import { loadPortfolioRunState } from '@/lib/portfolio/spine';
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

// Format guard analogous to the state/projection route.
const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;

  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

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

  // loadPortfolioRunState is internally fail-soft. Defense-in-depth wrapper.
  try {
    const db = getDb();
    const state = loadPortfolioRunState(db.$raw, workspaceId);
    return NextResponse.json(
      { portfolioRun: state },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store, must-revalidate' },
      },
    );
  } catch (err) {
    console.error('[portfolio/spine GET] unexpected error:', err);
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
