/**
 * POST /api/workstreams/[id]/merge-run  — A4 GATED Operator-Merge (2026-05-29, Opus 4.8)
 *
 * Schließt den Akkumulations-Loop: die zusammengesetzte Arbeit aller erfolgreichen
 * Steps liegt im Run-Branch `lazing/run/prun-…` (plan-executor-Accumulation). Diese
 * Route ist der EINZIGE user-gated Pfad, der ihn in den Live-Checkout (main des
 * Workspace-Repos) bringt — member-auth, explizit per Owner-Klick, NIE automatisch
 * (R1). Der `mergeRunWorktree`-Stub bleibt throw für nicht-gated Caller.
 *
 * Body:
 *   { preview?: true }  → S5 Diff-Preview: gibt Datei-Liste + Stat + aheadBy zurück,
 *                          KEIN Merge (read-only).
 *   { }                 → S6 Merge: commitGatedMerge(runBranch → Live-HEAD), konflikt-
 *                          sicher (Konflikt → merge --abort → Live sauber).
 *
 * Auth: Workspace-Member (401 → 404 → 403, Muster execute-plan/route.ts).
 * N8: schreibt eine workstream_decision (decisionKind 'route', verbatim rationale).
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

  // S5 — Diff-Preview (read-only).
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

  // S6 — der eigentliche gated Merge.
  const result = await commitGatedMerge({ repoPath, runBranch });

  // N8 — Audit/Decision (best-effort, wirft nie).
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

  // W1.4 (2026-05-30) — nach erfolgreichem gated Merge: die zusammengesetzte
  // Website serven (lokal + optional Tailscale via LAZYOS_SERVE_LOCAL) und eine
  // tappbare <surface:preview>-Karte in den Chat emittieren. Best-effort,
  // fail-soft (ein Serve-/Emit-Fehler darf die 200-Antwort nicht kippen). Reuse
  // des gemeinsamen Einhängepunkts (identisch zum Auto-Merge-Pfad W1.3).
  try {
    const { emitPreviewAfterMerge } = await import('@/lib/workstreams/plan-executor');
    await emitPreviewAfterMerge({
      workspaceId: ws.workspaceId,
      workstreamId: id,
      repoPath,
      title: ws.description ?? ws.name ?? `Workstream ${id}`,
    });
  } catch {
    /* non-fatal — der Merge ist erfolgt, die Preview ist best-effort */
  }

  return NextResponse.json({
    ok: true,
    merged: true,
    runBranch,
    sha: result.sha,
    files: diff.files,
  });
}
