/**
 * POST /api/flow/from-workstream
 *
 * Flow Studio — Stream C: „Als wiederkehrenden Prozess speichern" (2026-05-27).
 *
 * Body: { workstreamId: string, workspaceId: string, name?: string }
 *
 * Reads the root plan steps of a (finished or running) workstream and
 * compiles them via lib/flow/from-workstream.ts BACK into a new
 * flow_template + flow_steps (depends_on 1:1, tool/skill reconstructed from the
 * `| flow:` rationale annotation). Returns {flowId} →
 * repeatable via the existing POST /api/flow/[flowId]/run.
 *
 * Auth: workspace member (subject gate copied from
 *   app/api/flow/compose-and-run/route.ts — 401 → 403). NO cross-scope.
 *
 * ADDITIVE: no existing route touched, no next build/start, :4200 stays.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import {
  compileWorkstreamToFlow,
  FromWorkstreamError,
} from "@/lib/flow/from-workstream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PostBody {
  workstreamId?: unknown;
  workspaceId?: unknown;
  name?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

export async function POST(req: NextRequest): Promise<Response> {
  // 1. Auth gate (member-or-higher) — template compose-and-run/route.ts.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  // 2. Parse body.
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const workstreamId =
    typeof body.workstreamId === "string" ? body.workstreamId : "";
  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : "";
  // name is optional; passed through verbatim (N1), otherwise undefined → fallback.
  const name = typeof body.name === "string" ? body.name : undefined;

  if (workstreamId.trim().length === 0) {
    return NextResponse.json(
      { error: "invalid_workstream_id" },
      { status: 400 },
    );
  }
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json(
      { error: "invalid_workspace_id" },
      { status: 400 },
    );
  }

  // 3. Workspace permission (member-or-higher; viewer/foreign user → 403).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 4. Back-compile → flow_template + flow_steps. Return {flowId}.
  try {
    const result = compileWorkstreamToFlow(getDb().$raw, {
      workstreamId,
      workspaceId,
      ...(name !== undefined ? { name } : {}),
    });
    // Auto param extraction (Slice 2b-3, fail-soft): derive the variable values
    // as {{param.*}} from the captured runs of this structure + parametrize the
    // freshly saved template. NEVER breaks the save.
    let params: { key: string; observed: string[] }[] = [];
    let paramsHeuristic = false;
    try {
      const { autoParametrizeFlow } = await import("@/lib/flow/auto-parametrize");
      const ap = autoParametrizeFlow(getDb().$raw, {
        flowId: result.flowId,
        workstreamId,
        workspaceId,
      });
      params = ap.params.map((p) => ({ key: p.key, observed: p.observed }));
      paramsHeuristic = ap.heuristic;
    } catch {
      /* Auto-param is a convenience, not a required step */
    }
    return NextResponse.json(
      { flowId: result.flowId, stepCount: result.steps.length, params, paramsHeuristic },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof FromWorkstreamError) {
      const status = err.code === "no_steps" ? 404 : 400;
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status },
      );
    }
    return NextResponse.json(
      {
        error: "from_workstream_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
