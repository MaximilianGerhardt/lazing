/**
 * GET /api/reasoning-audit/unverified
 *
 * Top-50 unverifizierte Audit-Rows, sortiert nach Stake-Phase. Synthesis und
 * Cross-Roast haben höchste Priorität (User-relevante Endprodukte), V_n
 * niedriger (Iteration), Roaster ganz unten (Critic-Beifang).
 *
 * Privacy-Gate: requireSession.
 *
 * Pattern 5 Welle 3 (2026-05-01).
 */

import { NextResponse, type NextRequest } from "next/server";
import { isNull, sql } from "drizzle-orm";

import { getDb } from "@/db/client";
import { reasoningAudit } from "@/db/schema/reasoning_audit";
import { currentUserIdResolved } from "@/lib/security/subject-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAIM_PREVIEW_LEN = 200;
const ROW_LIMIT = 50;

export async function GET(req: NextRequest): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json(
      { error: "auth-required" },
      { status: 401 },
    );
  }

  const db = getDb();
  // Stake-basiertes ORDER BY: synthesis(0) > cross-roast(1) > sniper-inject(2)
  // > swarm-synthesis(3) > sub-spawn(4) > v_n(5) > roaster(6) > rest(7).
  // Innerhalb gleicher Stake: ts DESC.
  const stakeExpr = sql<number>`CASE
    WHEN ${reasoningAudit.phase} = 'synthesis' THEN 0
    WHEN ${reasoningAudit.phase} = 'cross-roast' THEN 1
    WHEN ${reasoningAudit.phase} = 'sniper-inject' THEN 2
    WHEN ${reasoningAudit.phase} = 'swarm-synthesis' THEN 3
    WHEN ${reasoningAudit.phase} = 'sub-spawn' THEN 4
    WHEN ${reasoningAudit.phase} LIKE 'v%' THEN 5
    WHEN ${reasoningAudit.role} LIKE 'iterate-roaster%' THEN 6
    ELSE 7
  END`;

  const rows = db
    .select({
      id: reasoningAudit.id,
      ts: reasoningAudit.ts,
      workstreamId: reasoningAudit.workstreamId,
      phase: reasoningAudit.phase,
      role: reasoningAudit.role,
      llmModel: reasoningAudit.llmModel,
      claimText: reasoningAudit.claimText,
      verifiedStatus: reasoningAudit.verifiedStatus,
      verifiedNote: reasoningAudit.verifiedNote,
      costCents: reasoningAudit.costCents,
    })
    .from(reasoningAudit)
    .where(isNull(reasoningAudit.verifiedStatus))
    .orderBy(stakeExpr, sql`${reasoningAudit.ts} DESC`)
    .limit(ROW_LIMIT)
    .all();

  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id,
      ts: r.ts instanceof Date ? r.ts.getTime() : r.ts,
      workstreamId: r.workstreamId,
      phase: r.phase,
      role: r.role,
      llmModel: r.llmModel,
      claimText: (r.claimText ?? "").slice(0, CLAIM_PREVIEW_LEN),
      verifiedStatus: r.verifiedStatus,
      verifiedNote: r.verifiedNote,
      costCents: r.costCents,
    })),
  });
}
