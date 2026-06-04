/**
 * PUT /api/workspaces/[id]/sandbox  (P16, 2026-05-01)
 * ----------------------------------------------------
 *
 * Toggle sandbox mode for a workspace.
 *
 * Body: { enabled: boolean }
 * Response: { ok: true, sandboxMode: 0 | 1 }
 *
 * Auth + permission:
 *   - requireSession via cookie (middleware layer)
 *   - user must be admin / founder in the workspace (canManageWorkspaceStructure)
 *
 * Constraints (hard, server-side):
 *   - enabling is ONLY allowed when workspace.sensitivity = 'low'
 *   - workspace must exist
 *   - loop guard / credential gates remain active in every case (see
 *     lib/workspaces/sandbox.ts JSDoc).
 */

import { NextResponse, type NextRequest } from "next/server";

import { getDb } from "@/db/client";
import {
  canManageWorkspaceStructure,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentSubject } from "@/lib/security/subject";
import { currentUserIdResolved } from "@/lib/security/subject-server";
import { setSandboxMode } from "@/lib/workspaces/sandbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Ctx {
  params: Promise<{ id: string }>;
}

interface PutBody {
  enabled?: unknown;
}

function isValidWorkspaceId(id: string): boolean {
  return /^[a-z0-9_(][a-z0-9_()-]{0,63}$/i.test(id);
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isValidWorkspaceId(id)) {
    return NextResponse.json(
      { error: "invalid_workspace_id" },
      { status: 400 },
    );
  }

  // Auth check: only user subjects (no service bypasses for structural
  // changes).
  const subj = currentSubject(req);
  if (subj.kind !== "user") {
    return NextResponse.json(
      { error: "user-required", hint: "Nur User dürfen Sandbox-Mode toggeln." },
      { status: 401 },
    );
  }
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required", hint: "Login erforderlich." },
      { status: 401 },
    );
  }

  // Permission: ≥ admin in the workspace.
  const role = getEffectiveWorkspaceRole(userId, id);
  if (!canManageWorkspaceStructure(role)) {
    return NextResponse.json(
      {
        error: "forbidden",
        hint: "Sandbox-Mode darf nur admin/founder eines Workspaces toggeln.",
      },
      { status: 403 },
    );
  }

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "invalid_body", hint: "Erwarte { enabled: boolean }" },
      { status: 400 },
    );
  }

  // Check the sensitivity floor BEFORE we call setSandboxMode — same
  // logic, but we want a meaningful 409 instead of a 500.
  try {
    const db = getDb();
    const row = db.$raw
      .prepare("SELECT sensitivity FROM workspaces WHERE id = ?")
      .get(id) as { sensitivity: string | null } | undefined;
    if (!row) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const sensitivity = row.sensitivity ?? "low";
    if (body.enabled && sensitivity !== "low") {
      return NextResponse.json(
        {
          error: "sandbox-only-on-low-sensitivity",
          hint:
            "Sandbox-Mode ist nur auf sensitivity='low' Workspaces erlaubt. " +
            "Senke die Sensitivity oder lasse den Workspace strict.",
          currentSensitivity: sensitivity,
        },
        { status: 409 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: "read_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  try {
    const result = await setSandboxMode(id, body.enabled);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("workspace-not-found:")) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (msg === "sandbox-only-on-low-sensitivity") {
      return NextResponse.json(
        { error: msg, hint: "Sandbox nur auf sensitivity='low' erlaubt." },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "update_failed", message: msg },
      { status: 500 },
    );
  }
}
