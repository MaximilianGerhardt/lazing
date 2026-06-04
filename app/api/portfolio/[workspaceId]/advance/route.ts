/**
 * POST /api/portfolio/[workspaceId]/advance
 *
 * Phase 2 W2.x (2026-05-29) — Portfolio-Orchestrator WRITE-route.
 *
 * Zwei Aktionen, gegated durch `action` im Body:
 *
 *   { action: 'create', lanes?, intent? }
 *       → createPortfolioRun → 201 + { portfolioRunId, laneWorkstreamIds }.
 *         Materialisiert den Run (parent mode='portfolio' + N Lane-Children),
 *         danach sieht `loadPortfolioRunState` einen ECHTEN State.
 *
 *   { action: 'advance', portfolioRunId, stage }   (default action)
 *       → advanceStage → 200.
 *         Schreibt die Stage-Completion-Decision NUR, wenn das Gate grün ist.
 *         Rotes Gate → 200 + { advanced:false, reason, gate } (kein Write,
 *         kein Fehler — der Caller sieht verbatim, was blockiert).
 *
 * ── Auth-Gate (member-Muster wie execute-plan / spine GET) ────────────────
 *   (A) currentUserIdResolved      → 401 wenn nicht eingeloggt.
 *   (B) canEditWorkspaceContent    → 403 wenn < member.
 *   (C) hasRealWorkspaceMembership → 403 (IDOR-Härtung).
 *
 * ── Scope-Härtung ─────────────────────────────────────────────────────────
 *   Bei action='advance' verifizieren wir, dass der portfolioRunId WIRKLICH
 *   zum [workspaceId] der URL gehört, bevor wir advancen — kein cross-scope
 *   Advance über eine fremde Run-ID.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getDb } from '@/db/client';
import {
  advanceStage,
  createPortfolioRun,
  getPortfolioRunStatus,
} from '@/lib/portfolio/orchestrator';
import { LANE_IDS } from '@/lib/portfolio/types';
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

// Format-Guard analog spine GET-Route.
const WORKSPACE_ID_RE = /^(?:__org_root__:)?[a-zA-Z0-9_:()-]{1,128}$/;

const STAGE_IDS = [
  'governance-gate-contract',
  'source-event-envelope',
  'expertise-object-model',
  'role-decision-dependency-model',
  'toolstack-replacement-model',
  'innovation-reframe-model',
  'mobile-surface-model',
  'flow-graph-workstream-dag',
  'critic-eval-gates',
  'build-graph',
  'reconciliation-belief-update',
] as const;

const CreateSchema = z.object({
  action: z.literal('create'),
  lanes: z.array(z.enum([...LANE_IDS] as [string, ...string[]])).optional(),
  intent: z.string().max(4000).optional(),
});

const AdvanceSchema = z.object({
  action: z.literal('advance').optional(),
  portfolioRunId: z.string().min(1),
  stage: z.enum(STAGE_IDS),
});

const BodySchema = z.union([CreateSchema, AdvanceSchema]);

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { workspaceId } = await ctx.params;

  if (typeof workspaceId !== 'string' || !WORKSPACE_ID_RE.test(workspaceId)) {
    return NextResponse.json(
      { error: 'invalid_workspace_id' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // (A) Auth.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: 'auth-required' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // (B) Rolle.
  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // (C) IDOR-Härtung.
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Body parsen.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation_error', issues: parsed.error.issues },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const db = getDb();

    // ── create ───────────────────────────────────────────────────────────
    if (parsed.data.action === 'create') {
      const result = createPortfolioRun(db.$raw, {
        workspaceId,
        lanes: parsed.data.lanes,
        intent: parsed.data.intent,
      });
      return NextResponse.json(
        {
          ok: true,
          portfolioRunId: result.portfolioRunId,
          laneWorkstreamIds: result.laneWorkstreamIds,
          lanes: result.lanes,
        },
        { status: 201, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // ── advance (default) ──────────────────────────────────────────────────
    const { portfolioRunId, stage } = parsed.data;

    // Scope-Härtung: der Run MUSS zu diesem Workspace gehören.
    const status = getPortfolioRunStatus(db.$raw, portfolioRunId);
    if (!status || status.state.workspaceId !== workspaceId) {
      return NextResponse.json(
        { error: 'not_found' },
        { status: 404, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const result = advanceStage(db.$raw, { portfolioRunId, stage });
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[portfolio/advance POST] unexpected error:', err);
    return NextResponse.json(
      { error: 'internal_error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
