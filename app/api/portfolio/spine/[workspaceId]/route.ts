/**
 * GET /api/portfolio/spine/[workspaceId]
 *
 * Phase 2 W2.0 (2026-05-29) — Portfolio-Spine read-route.
 *
 * Liefert den deterministischen `PortfolioRunState` eines Workspace
 * (siehe `lib/portfolio/types.ts`). Wenn kein Portfolio-Run für den
 * Workspace existiert, geben wir 200 + `{ portfolioRun: null }` zurück
 * (Owner: „read-only Probe, kein Fehler wenn leer").
 *
 * ── Auth-Gate ────────────────────────────────────────────────────────────
 *   Gespiegelt aus `app/api/state/projection/[workspaceId]/route.ts`:
 *   (A) currentUserIdResolved        → 401 wenn nicht eingeloggt.
 *   (B) canEditWorkspaceContent      → 403 wenn < member.
 *   (C) hasRealWorkspaceMembership   → 403 (IDOR-Härtung).
 *
 * ── Cache-Disziplin ──────────────────────────────────────────────────────
 *   no-store, must-revalidate. State ist per Definition zeit-sensitiv —
 *   eine eben merged Stage muss SOFORT in `completedMergeStages` auftauchen.
 *
 * ── Read-Only ────────────────────────────────────────────────────────────
 *   Diese Route schreibt NIE. Kein Audit-Row, kein State-Mutation.
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

// Format-Guard analog state/projection-Route.
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

  // loadPortfolioRunState ist intern fail-soft. Defense-in-Depth-Wrapper.
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
