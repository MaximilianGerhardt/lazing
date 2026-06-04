/**
 * POST /api/flow/learn-latest
 *
 * Self-learning — explicit trigger (owner: „weil man es explizit sagt und
 * anmerkt"). Body: { workspaceId: string, name?: string }.
 *
 * Resolves the MOST RECENTLY updated (root) workstream of the workspace and
 * compiles it via compileWorkstreamToFlow into a reusable
 * flow_template — the manual counterpart to the automatic repetition detector
 * (Slice 1). Used by the `/learn` slash command. Returns {flowId} →
 * repeatable via POST /api/flow/[flowId]/run.
 *
 * Auth: workspace member (template: from-workstream/route.ts). No cross-scope.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { listWorkstreams } from "@/lib/workstreams/service";
import {
  compileWorkstreamToFlow,
  FromWorkstreamError,
} from "@/lib/flow/from-workstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  workspaceId?: unknown;
  name?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "invalid_workspace_id" }, { status: 400 });
  }
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Resolve the most recently updated root workstream (listWorkstreams orders
  // by desc(updatedAt)). No workstream → 404 (nothing to learn).
  const recent = await listWorkstreams({ workspaceId, limit: 1 });
  const latest = recent[0];
  if (!latest) {
    return NextResponse.json(
      { error: "no_workstream", message: "Kein Workstream in diesem Workspace zum Merken." },
      { status: 404 },
    );
  }

  try {
    const result = compileWorkstreamToFlow(getDb().$raw, {
      workstreamId: latest.id,
      workspaceId,
      ...(name !== undefined ? { name } : {}),
    });
    // Auto param extraction (Slice 2b-3, fail-soft).
    let params: { key: string; observed: string[] }[] = [];
    let paramsHeuristic = false;
    try {
      const { autoParametrizeFlow } = await import("@/lib/flow/auto-parametrize");
      const ap = autoParametrizeFlow(getDb().$raw, {
        flowId: result.flowId,
        workstreamId: latest.id,
        workspaceId,
      });
      params = ap.params.map((p) => ({ key: p.key, observed: p.observed }));
      paramsHeuristic = ap.heuristic;
    } catch {
      /* Convenience, not a required step */
    }
    return NextResponse.json(
      {
        flowId: result.flowId,
        stepCount: result.steps.length,
        workstreamId: latest.id,
        sourceTitle: latest.name ?? null,
        params,
        paramsHeuristic,
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof FromWorkstreamError) {
      const status = err.code === "no_steps" ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    return NextResponse.json(
      { error: "learn_failed", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
