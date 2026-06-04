/**
 * GET /api/rag/index/[runId]/status (Sub-Plan 5 Welle 2, 2026-05-01).
 *
 * Liefert einen `RagRunStatus`-Snapshot für den Stepper-Adapter
 * (`lib/rag/progress-adapter.ts`).
 *
 * Run-Identifikation:
 *   `runId` ist ein Pseudo-Identifier `<workspaceId>::<sourceType>` oder
 *   `<workspaceId>::all`. Der Indexer hat keine Run-Entity (er ist
 *   stateful per workspace+sourceType in `rag_indexer_state`), daher
 *   leiten wir den Phase-/Progress-Status aus dem aktuellen
 *   `ragIndexerState`-Row + ragChunks-Counts ab.
 *
 * Phase-Mapping (best-effort, da kein expliziter Phase-Marker in DB):
 *   - circuitOpen=1                                  → 'circuit-open'
 *   - failedRuns > 0 + lastIndexedTs nicht aktuell   → 'failed'
 *   - lastIndexedTs == jetzt-ish + chunks vorhanden  → 'done'
 *   - kein State-Row                                 → 'idle'
 *
 * Out-of-scope (kommt mit echtem Run-Schema):
 *   - 'discover-sources' / 'chunk' / 'embed' / 'persist' / 'cleanup'
 *     Live-Phase. Aktuell nur Done/Failed/Circuit/Idle aus DB ableitbar —
 *     der Adapter rendert Idle-Stages dann als "pending", was korrekt ist.
 *
 * Auth:
 *   - Nur authentifizierte User
 *   - Liefert keine Chunk-Inhalte (Privacy-Gate)
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

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min — danach gilt Run als "alt"

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

  // Total-Chunks aktuell — auch wenn kein State-Row da
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
    // Kein State → noch nie indiziert / oder gerade erst gestartet
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
    embeddedCount: persistedCount, // Best-effort — embedded == persisted im Indexer
    lastUpdateMs,
    errorMessage,
  };

  return NextResponse.json(status);
}
