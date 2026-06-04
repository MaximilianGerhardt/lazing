/**
 * GET /api/reasoning-audit?workstreamId=...
 *
 * Listet die letzten 50 Audit-Rows (sortiert nach ts DESC). Wenn workstreamId
 * gesetzt ist, gefiltert auf diesen Workstream — sonst alle.
 *
 * Returns: Array von { id, ts, phase, role, claimText (slice 200),
 *                      verifiedStatus, verifiedNote, costCents }.
 *
 * Privacy-Gate: requireSession (currentUserIdResolved). 401 ohne Session.
 *
 * Pattern 5 Welle 3 (2026-05-01).
 */

import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";

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
      { error: "auth-required", hint: "Bitte einloggen." },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const workstreamId = url.searchParams.get("workstreamId");

  const db = getDb();
  const baseQuery = db
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
    .from(reasoningAudit);

  const filtered = workstreamId
    ? baseQuery.where(eq(reasoningAudit.workstreamId, workstreamId))
    : baseQuery;

  const rows = filtered
    .orderBy(desc(reasoningAudit.ts))
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
