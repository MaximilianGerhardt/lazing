/**
 * POST /api/workstreams/[id]/merge-run  — A4 GATED Operator-Merge (2026-05-29, Opus 4.8)
 *
 * Closes the accumulation loop: the assembled work of all successful
 * steps lives in the run branch `lazing/run/prun-…` (plan-executor accumulation). This
 * route is the ONLY user-gated path that brings it into the live checkout (main of
 * the workspace repo) — member auth, explicitly by owner click, NEVER automatically
 * (R1). The `mergeRunWorktree` stub keeps throwing for non-gated callers.
 *
 * Body:
 *   { preview?: true }  → S5 diff preview: returns file list + stat + aheadBy,
 *                          NO merge (read-only).
 *   { }                 → S6 merge: commitGatedMerge(runBranch → live HEAD), conflict-
 *                          safe (conflict → merge --abort → live clean).
 *
 * Auth: workspace member (401 → 404 → 403, pattern execute-plan/route.ts).
 * N8: writes a workstream_decision (decisionKind 'route', verbatim rationale).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getWorkstream } from '@/lib/workstreams/service';
import { getWorkspace } from '@/lib/workspaces';
import { defaultWorkspacePath } from '@/lib/workspaces/projects-root';
import {
  findRunBranchForWorkstream,
  getRunBranchDiffStat,
  commitGatedMerge,
} from '@/lib/agents/worktree-manager';
import { writeDecision } from '@/lib/workstreams/trace-repo';
import { currentUserIdResolved } from '@/lib/security/subject-server';
import { canEditWorkspaceContent, getEffectiveWorkspaceRole } from '@/lib/security/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  preview: z.boolean().optional(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

async function resolveRepoPath(workspaceId: string): Promise<string> {
  try {
    const ws = await getWorkspace(workspaceId);
    if (ws?.path) return ws.path;
  } catch {
    /* fall through */
  }
  return defaultWorkspacePath(workspaceId);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;

  const userId = currentUserIdResolved(req);
  if (!userId) return NextResponse.json({ error: 'auth-required' }, { status: 401 });

  const ws = await getWorkstream(id);
  if (!ws) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, ws.workspaceId))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: z.infer<typeof BodySchema> = {};
  try {
    const raw = await req.json().catch(() => ({}));
    body = BodySchema.parse(raw ?? {});
  } catch {
    body = {};
  }

  const repoPath = await resolveRepoPath(ws.workspaceId);
  const runBranch = await findRunBranchForWorkstream(repoPath, id);
  if (!runBranch) {
    return NextResponse.json(
      { error: 'no_run_branch', hint: `Kein lazing/run/*-Branch für Workstream ${id} in ${repoPath}.` },
      { status: 404 },
    );
  }

  // S5 — diff preview (read-only).
  const diff = await getRunBranchDiffStat(repoPath, runBranch);
  if (body.preview === true) {
    return NextResponse.json({
      ok: true,
      preview: true,
      runBranch,
      files: diff.files,
      stat: diff.stat,
      aheadBy: diff.aheadBy,
    });
  }

  // S6 — the actual gated merge.
  const result = await commitGatedMerge({ repoPath, runBranch });

  // N8 — audit/decision (best-effort, never throws).
  try {
    writeDecision({
      workspaceId: ws.workspaceId,
      workstreamId: id,
      coordKey: `${ws.workspaceId}/${id}`,
      decisionKind: 'route',
      rationale: result.merged
        ? `gated-merge: Run-Branch ${runBranch} (${diff.files.length} Dateien) durch Owner ${userId} in Live-Checkout gemergt (${result.sha ?? 'sha?'}).`
        : `gated-merge ABGEBROCHEN: ${runBranch} → Konflikt, Live unverändert. ${result.conflict ?? ''}`,
      actor: 'user',
    });
  } catch {
    /* non-fatal */
  }

  if (!result.merged) {
    return NextResponse.json(
      { ok: false, merged: false, runBranch, conflict: result.conflict, files: diff.files },
      { status: 409 },
    );
  }

  // W1.4 (2026-05-30) — after a successful gated merge: serve the assembled
  // website (local + optional Tailscale via LAZYOS_SERVE_LOCAL) and emit a
  // tappable <surface:preview> card into the chat. Best-effort,
  // fail-soft (a serve/emit error must not topple the 200 response). Reuse
  // of the shared hook point (identical to the auto-merge path W1.3).
  try {
    const { emitPreviewAfterMerge } = await import('@/lib/workstreams/plan-executor');
    await emitPreviewAfterMerge({
      workspaceId: ws.workspaceId,
      workstreamId: id,
      repoPath,
      title: ws.description ?? ws.name ?? `Workstream ${id}`,
    });
  } catch {
    /* non-fatal — the merge happened, the preview is best-effort */
  }

  return NextResponse.json({
    ok: true,
    merged: true,
    runBranch,
    sha: result.sha,
    files: diff.files,
  });
}
