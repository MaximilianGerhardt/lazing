/**
 * GET /api/rag/status?workspaceId=ID
 *
 * Liefert RAG-Index-Statistik pro Workspace:
 *   - chunkCount, tokenSum
 *   - sourceTypeBreakdown
 *   - lastIndexedAt
 *   - circuitOpen (Loop-Guard-Indikator)
 *
 * Privacy-Gate: Liefert nur Counts, NIE Chunk-Inhalte.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db/client';
import { ragChunks, ragIndexerState } from '@/db/schema/rag';
import { eq, and, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const url = req.nextUrl;
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId required' }, { status: 400 });
  }

  const db = getDb();

  const totals = db
    .select({
      sourceType: ragChunks.sourceType,
      count: sql<number>`count(*)`,
      tokenSum: sql<number>`coalesce(sum(${ragChunks.tokenCount}), 0)`,
    })
    .from(ragChunks)
    .where(eq(ragChunks.workspaceId, workspaceId))
    .groupBy(ragChunks.sourceType)
    .all();

  const lastIndexed = db
    .select({
      circuitOpen: ragIndexerState.circuitOpen,
      lastIndexedTs: ragIndexerState.lastIndexedTs,
      totalChunks: ragIndexerState.totalChunks,
      failedRuns: ragIndexerState.failedRuns,
    })
    .from(ragIndexerState)
    .where(
      and(
        eq(ragIndexerState.workspaceId, workspaceId),
        eq(ragIndexerState.sourceType, 'all'),
      ),
    )
    .limit(1)
    .all();

  const totalChunks = totals.reduce((s, r) => s + Number(r.count), 0);
  const totalTokens = totals.reduce((s, r) => s + Number(r.tokenSum), 0);

  return NextResponse.json({
    workspaceId,
    totalChunks,
    totalTokens,
    sourceTypes: totals.map((t) => ({
      type: t.sourceType,
      count: Number(t.count),
      tokens: Number(t.tokenSum),
    })),
    lastIndexedAt: lastIndexed[0]?.lastIndexedTs ?? null,
    circuitOpen: lastIndexed[0]?.circuitOpen === 1,
    failedRuns: lastIndexed[0]?.failedRuns ?? 0,
  });
}
