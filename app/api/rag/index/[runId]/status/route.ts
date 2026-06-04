/**
 * GET /api/rag/index/[runId]/status (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Returns a `RagRunStatus` snapshot for the stepper adapter
 * (`lib/rag/progress-adapter.ts`).
 *
 * Run identification:
 *   `runId` is a pseudo-identifier `<workspaceId>::<sourceType>` or
 *   `<workspaceId>::all`. The indexer has no run entity (it is
 *   stateful per workspace+sourceType in `rag_indexer_state`), so
 *   we derive the phase/progress status from the current
 *   `ragIndexerState` row + ragChunks counts.
 *
 * Phase mapping (best-effort, since no explicit phase marker in DB):
 *   - circuitOpen=1                                  → 'circuit-open'
 *   - failedRuns > 0 + lastIndexedTs not current     → 'failed'
 *   - lastIndexedTs == now-ish + chunks present      → 'done'
 *   - no state row                                   → 'idle'
 *
 * Out-of-scope (arrives with a real run schema):
 *   - 'discover-sources' / 'chunk' / 'embed' / 'persist' / 'cleanup'
 *     live phase. Currently only Done/Failed/Circuit/Idle derivable from DB —
 *     the adapter then renders idle stages as "pending", which is correct.
 *
 * Auth:
 *   - Authenticated users only
 *   - Returns no chunk contents (privacy gate)
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@/db/client';
import { ragChunks, ragIndexerState } from '@/db/schema/rag';
import { eq, and, sql } from 'drizzle-orm';

import { currentUserIdResolved } from '@/lib/security/subject-server';
import {
  canReadWorkspace,
  getEffectiveWorkspaceRole,
} from '@/lib/security/permissions';
import { getWorkspace } from '@/lib/workspaces';
import type { RagRunStatus, RagPhase } from '@/lib/rag/progress-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min — after that the run counts as "stale"

interface RouteParams {
  params: Promise<{ runId: string }>;
}

function parseRunId(
  runId: string,
): { workspaceId: string; sourceType: string } | null {
  const idx = runId.indexOf('::');
  if (idx <= 0) return null;
  const workspaceId = runId.slice(0, idx);
  const sourceType = runId.slice(idx + 2);
  if (!workspaceId || !sourceType) return null;
  return { workspaceId, sourceType };
}

export async function GET(
  req: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    return NextResponse.json({ error: 'auth-required' }, { status: 401 });
  }

  const { runId } = await params;
  const parsed = parseRunId(runId);
  if (!parsed) {
    return NextResponse.json(
      {
        error: 'invalid-run-id',
        hint: 'runId must be "<workspaceId>::<sourceType>" or "<workspaceId>::all"',
      },
      { status: 400 },
    );
  }

  const ws = await getWorkspace(parsed.workspaceId).catch(() => null);
  if (!ws) {
    return NextResponse.json({ error: 'workspace-not-found' }, { status: 404 });
  }
  if (!canReadWorkspace(getEffectiveWorkspaceRole(userId, ws.id))) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const db = getDb();
  const now = Date.now();

  const stateRows = db
    .select({
      circuitOpen: ragIndexerState.circuitOpen,
      lastIndexedTs: ragIndexerState.lastIndexedTs,
      totalChunks: ragIndexerState.totalChunks,
      failedRuns: ragIndexerState.failedRuns,
      updatedAt: ragIndexerState.updatedAt,
    })
    .from(ragIndexerState)
    .where(
      and(
        eq(ragIndexerState.workspaceId, parsed.workspaceId),
        eq(ragIndexerState.sourceType, parsed.sourceType),
      ),
    )
    .limit(1)
    .all();

  // Current total chunks — even when no state row is present
  const chunkRows = db
    .select({ count: sql<number>`count(*)` })
    .from(ragChunks)
    .where(eq(ragChunks.workspaceId, parsed.workspaceId))
    .all();
  const persistedCount = Number(chunkRows[0]?.count ?? 0);

  const stateRow = stateRows[0];
  let phase: RagPhase = 'idle';
  let errorMessage: string | undefined;
  let lastUpdateMs: number | undefined;

  if (!stateRow) {
    // No state → never indexed / or just started
    phase = persistedCount > 0 ? 'done' : 'idle';
  } else {
    lastUpdateMs = stateRow.updatedAt;
    if (stateRow.circuitOpen === 1) {
      phase = 'circuit-open';
      errorMessage = `Circuit-Breaker offen (failed_runs=${stateRow.failedRuns})`;
    } else if (
      stateRow.failedRuns > 0 &&
      now - stateRow.lastIndexedTs > STALE_THRESHOLD_MS
    ) {
      phase = 'failed';
      errorMessage = `letzter Run vor ${Math.round((now - stateRow.lastIndexedTs) / 60000)}min fehlgeschlagen`;
    } else if (stateRow.totalChunks > 0) {
      phase = 'done';
    } else {
      phase = 'idle';
    }
  }

  const status: RagRunStatus = {
    workspaceId: parsed.workspaceId,
    runId,
    phase,
    totalChunks: stateRow?.totalChunks ?? undefined,
    persistedCount,
    embeddedCount: persistedCount, // Best-effort — embedded == persisted in the indexer
    lastUpdateMs,
    errorMessage,
  };

  return NextResponse.json(status);
}
