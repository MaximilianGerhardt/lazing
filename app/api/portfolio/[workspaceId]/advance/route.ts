/**
 * POST /api/portfolio/[workspaceId]/advance
 *
 * Phase 2 W2.x (2026-05-29) — portfolio-orchestrator WRITE route.
 *
 * Two actions, gated by `action` in the body:
 *
 *   { action: 'create', lanes?, intent? }
 *       → createPortfolioRun → 201 + { portfolioRunId, laneWorkstreamIds }.
 *         Materializes the run (parent mode='portfolio' + N lane children),
 *         after which `loadPortfolioRunState` sees a REAL state.
 *
 *   { action: 'advance', portfolioRunId, stage }   (default action)
 *       → advanceStage → 200.
 *         Writes the stage-completion decision ONLY when the gate is green.
 *         Red gate → 200 + { advanced:false, reason, gate } (no write,
 *         no error — the caller sees verbatim what blocks).
 *
 * ── Auth gate (member pattern like execute-plan / spine GET) ──────────────
 *   (A) currentUserIdResolved      → 401 when not logged in.
 *   (B) canEditWorkspaceContent    → 403 when < member.
 *   (C) hasRealWorkspaceMembership → 403 (IDOR hardening).
 *
 * ── Scope hardening ───────────────────────────────────────────────────────
 *   On action='advance' we verify that the portfolioRunId REALLY
 *   belongs to the [workspaceId] of the URL before we advance — no cross-scope
 *   advance via a foreign run ID.
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

// Format guard analogous to the spine GET route.
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

  // (B) Role.
  const role = getEffectiveWorkspaceRole(userId, workspaceId);
  if (!canEditWorkspaceContent(role)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // (C) IDOR hardening.
  if (!hasRealWorkspaceMembership(userId, workspaceId)) {
    return NextResponse.json(
      { error: 'forbidden' },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Parse body.
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

    // Scope hardening: the run MUST belong to this workspace.
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
