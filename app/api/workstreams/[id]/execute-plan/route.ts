/**
 * POST /api/workstreams/[id]/execute-plan
 *
 * Slice 3 · Phase 1 — NON-DESTRUCTIVE plan execution (2026-05-23).
 *
 * Starts the sequential plan executor (`executePlan`) in the background.
 * Per step ONLY `engine.chat()` is called (pure text completion,
 * no code execute, no file write). Responds immediately with HTTP 202.
 *
 * Template: app/api/workstreams/[id]/spawn/route.ts (background-run pattern).
 *
 * Auth: a cookie session suffices (default API auth via middleware).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getWorkstream } from '@/lib/workstreams/service';
import { executePlan } from '@/lib/workstreams/plan-executor';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  planId: z.string().min(1),
  // coordKey is optional — we derive it from workspaceId+workstreamId
  // if the caller does not pass it explicitly.
  coordKey: z.string().min(1).optional(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;

  // Ownership check (Critic-M3-Fix, 2026-05-23): only logged-in workspace
  // editors may start a plan run. Without it any authenticated
  // caller could trigger a run on a foreign workstream via a foreign
  // workstreamId. Pattern analogous to app/api/rag/index/route.ts (401 → 404 → 403).
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  // Validate the workstream (404 if unknown).
  const ws = await getWorkstream(id);
  if (!ws) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Effective workspace role: viewers/guests/foreign users → 403.
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Parse the body.
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
      { status: 400 },
    );
  }

  const { planId } = parsed.data;
  // coordKey derivation: if not passed, we use the canonical
  // ManifestCoord key format (N9): "<workspaceId>/<workstreamId>".
  const coordKey = parsed.data.coordKey ?? `${ws.workspaceId}/${ws.id}`;

  // Background spawn (no await, return 202 immediately).
  // executePlan is best-effort/non-fatal per step — errors land in console.error.
  void executePlan({
    workstreamId: ws.id,
    workspaceId: ws.workspaceId,
    planId,
    coordKey,
  }).catch((err: unknown) => {
    console.error(
      '[execute-plan] executePlan background error:',
      err instanceof Error ? err.message : String(err),
    );
  });

  return NextResponse.json(
    { ok: true, planId, workstreamId: id },
    { status: 202 },
  );
}
