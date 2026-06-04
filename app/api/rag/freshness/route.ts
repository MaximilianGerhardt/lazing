/**
 * GET /api/rag/freshness
 *
 * Returns coverage stats of the RAG index per source type — analogous to
 * `pnpm tsx scripts/audit-rag-coverage.ts --json`. Useful for the health
 * dashboard.
 *
 * Auth: requireSession OR Bearer $LAZYOS_PUSH_SECRET (for the health
 * check cron).
 *
 * P12 (2026-05-01).
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUserIdResolved } from "@/lib/security/subject-server";
import { getCoverage } from "@/scripts/audit-rag-coverage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthed(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.LAZYOS_PUSH_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  return Boolean(currentUserIdResolved(req));
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!isAuthed(req)) {
    return NextResponse.json({ error: "auth-required" }, { status: 401 });
  }
  try {
    const rows = getCoverage();
    const summary = {
      fresh: rows.filter((r) => r.status === "fresh").length,
      stale: rows.filter((r) => r.status === "stale").length,
      veryStale: rows.filter((r) => r.status === "very-stale").length,
      missing: rows.filter((r) => r.status === "missing").length,
    };
    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      summary,
      rows,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "coverage-failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
