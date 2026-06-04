/**
 * GET /api/reasoning-audit/[id]
 *
 * Single Audit-Row mit voll entpackten JSON-Feldern (sourceChunks,
 * priorOutputs, userCorrections). Klartext-Prompts (system_prompt_text /
 * user_prompt_text) werden NICHT zurückgegeben — sie sind sensitiv und
 * primär für interne Re-Spawn-Logik gedacht.
 *
 * Privacy-Gate: requireSession.
 *
 * Pattern 5 Welle 3 (2026-05-01).
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

  // Privacy-Sprint V5 (2026-05-01): Workspace-Membership-Check.
  // Audits mit workspaceId sind nur für Workspace-Members lesbar
  // (≥ viewer). Audits ohne workspaceId bleiben für jeden eingeloggten
  // User lesbar — sie enthalten keinen workspace-spezifischen Twin.
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
    // Klartext-Prompts: nur Marker ob sie persistiert sind (für UI-Hinweis
    // "Verifizierung möglich"). Kein Klartext-Leak.
    hasFullPrompts: Boolean(row.systemPromptText && row.userPromptText),
  });
}
