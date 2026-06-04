/**
 * POST /api/flow/[flowId]/run
 *
 * Flow Studio — run-after-coupling (Track-D · 2026-05-27).
 *
 * Body: { workspaceId: string }
 *
 * Called AFTER the credential-coupling surface has connected the missing tools
 * of a flow previously composed via /api/flow/compose-and-run.
 * The flow already exists (flow_template + flow_steps); here it is only
 * dispatched + executed:
 *
 *   dispatchFlow → execution trigger (the EXISTING executePlan) →
 *     200 { status:'running', flowId, runId, workstreamId }.
 *
 * Auth: workspace member (subject gate like compose-and-run/route.ts — 401 → 403).
 *
 * ADDITIVE: no existing route touched, no next build/start.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import {
  canEditWorkspaceContent,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { runDispatchedFlow } from "@/lib/flow/compose-and-run";
import { FlowDispatchError } from "@/lib/flow/execute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ flowId: string }>;
}

interface PostBody {
  workspaceId?: unknown;
  /** Slice 2 (2026-06-03): {{param.*}} values for runtime interpolation. */
  params?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  // 1. Auth gate.
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }

  const { flowId } = await ctx.params;
  if (typeof flowId !== "string" || flowId.length === 0) {
    return NextResponse.json({ error: "invalid_flow_id" }, { status: 400 });
  }

  // 2. Parse the body.
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const workspaceId =
    typeof body.workspaceId === "string" ? body.workspaceId : "";
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json(
      { error: "invalid_workspace_id" },
      { status: 400 },
    );
  }

  // 3. Workspace permission (member-or-higher).
  if (!canEditWorkspaceContent(getEffectiveWorkspaceRole(userId, workspaceId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 4. Dispatch + execution trigger (default = the existing executePlan).
  //    Slice 2: pass through optional {{param.*}} values (sanitized).
  const { sanitizeParamValues } = await import("@/lib/flow/interpolate");
  const params = sanitizeParamValues(body.params);
  try {
    const result = runDispatchedFlow(getDb().$raw, {
      flowId,
      workspaceId,
      ...(Object.keys(params).length > 0 ? { params } : {}),
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof FlowDispatchError) {
      const status = err.code === "flow_not_found" ? 404 : 400;
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status },
      );
    }
    return NextResponse.json(
      {
        error: "flow_run_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
