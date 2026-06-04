/**
 * GET /api/reasoning-audit/[id]
 *
 * Single audit row with fully unpacked JSON fields (sourceChunks,
 * priorOutputs, userCorrections). Plaintext prompts (system_prompt_text /
 * user_prompt_text) are NOT returned — they are sensitive and
 * primarily intended for internal re-spawn logic.
 *
 * Privacy gate: requireSession.
 *
 * Pattern 5 wave 3 (2026-05-01).
 */

import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { reasoningAudit } from "@/db/schema/reasoning_audit";
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from "@/lib/security/permissions";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext,
): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required" },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;
  const db = getDb();
  const row = db
    .select()
    .from(reasoningAudit)
    .where(eq(reasoningAudit.id, id))
    .all()[0];

  if (!row) {
    return NextResponse.json({ error: "not-found" }, { status: 404 });
  }

  // Privacy sprint V5 (2026-05-01): workspace membership check.
  // Audits with a workspaceId are readable only by workspace members
  // (≥ viewer). Audits without a workspaceId stay readable for every logged-in
  // user — they contain no workspace-specific twin.
  if (row.workspaceId) {
    const role = getEffectiveWorkspaceRole(userId, row.workspaceId);
    if (!canReadWorkspace(role)) {
      return NextResponse.json({ error: "not-found" }, { status: 404 });
    }
  }

  return NextResponse.json({
    id: row.id,
    ts: row.ts instanceof Date ? row.ts.getTime() : row.ts,
    workspaceId: row.workspaceId,
    workstreamId: row.workstreamId,
    parentTicketId: row.parentTicketId,
    phase: row.phase,
    role: row.role,
    llmProvider: row.llmProvider,
    llmModel: row.llmModel,
    promptHash: row.promptHash,
    claimText: row.claimText,
    sourceChunks: safeParse(row.sourceChunksJson),
    priorOutputs: safeParse(row.priorOutputsJson),
    userCorrections: safeParse(row.userCorrectionsJson),
    costCents: row.costCents,
    durationMs: row.durationMs,
    outputTokens: row.outputTokens,
    verifiedStatus: row.verifiedStatus,
    verifiedAt: row.verifiedAt,
    verifiedNote: row.verifiedNote,
    // Plaintext prompts: only a marker whether they are persisted (for the UI hint
    // "verification possible"). No plaintext leak.
    hasFullPrompts: Boolean(row.systemPromptText && row.userPromptText),
  });
}
