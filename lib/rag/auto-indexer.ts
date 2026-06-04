/**
 * RAG auto-indexer (2026-05-24).
 *
 * Populates `rag_chunks` for ALL non-archived, non-high-sensitivity
 * workspaces with chat sources — so that RAG-in-chat actually provides
 * context at boot (otherwise: 0 chunks → retrieve() always returns empty).
 *
 * Design decisions:
 *   - Fire-and-forget: started from instrumentation.ts via setTimeout (30s after
 *     boot), does NOT block the server start.
 *   - Best-effort: one error per workspace does not kill the rest.
 *   - Loop-guard: indexBatch() has a built-in 60s debounce + circuit breaker
 *     via rag_indexer_state — no re-index storm possible.
 *   - No file indexing: workspace.path is often empty/external on the VPS.
 *     Chat sources are the immediately useful source for RAG-in-chat.
 *   - N2-compliant: no cross-workspace retrieval, each source carries its
 *     workspaceId explicitly.
 *   - N1-compliant: payload.content is passed verbatim to indexBatch,
 *     no .slice / .substring.
 *
 * Exports:
 *   indexAllWorkspaces(opts?) — public API, also callable directly via script.
 */

import { getDb } from '@/db/client';
import { events } from '@/db/schema/events';
import { eq, and, desc } from 'drizzle-orm';
import { listWorkspaces } from '@/lib/workspaces';
import { indexBatch, type IndexableSource } from '@/lib/rag/indexer';

export interface AutoIndexResult {
  workspaces: number;
  chunks: number;
}

const DEFAULT_MAX_CHAT_PER_WS = 300;

/**
 * Indexes the chat history of all active, non-high-sensitivity workspaces.
 *
 * @param opts.maxChatPerWs - Max chat_message_completed events per workspace (default 300).
 * @returns Number of processed workspaces + total new chunks.
 */
export async function indexAllWorkspaces(
  opts?: { maxChatPerWs?: number },
): Promise<AutoIndexResult> {
  const maxChatPerWs = opts?.maxChatPerWs ?? DEFAULT_MAX_CHAT_PER_WS;

  let allWorkspaces;
  try {
    allWorkspaces = await listWorkspaces({ includeArchived: false });
  } catch (err) {
    console.warn('[rag-auto-indexer] listWorkspaces failed — skip boot index:', err);
    return { workspaces: 0, chunks: 0 };
  }

  // Privacy gate: never index high-sensitivity workspaces.
  const eligibleWorkspaces = allWorkspaces.filter((ws) => ws.sensitivity !== 'high');

  if (eligibleWorkspaces.length === 0) {
    console.log('[rag-auto-indexer] no eligible workspaces — nothing to index');
    return { workspaces: 0, chunks: 0 };
  }

  const db = getDb();
  let totalWorkspacesIndexed = 0;
  let totalChunks = 0;

  for (const ws of eligibleWorkspaces) {
    try {
      // Collect chat sources — identical logic to app/api/rag/index/route.ts.
      const rows = db
        .select({
          id: events.id,
          payload: events.payload,
          sensitivity: events.sensitivity,
          createdAt: events.createdAt,
        })
        .from(events)
        .where(
          and(
            eq(events.segmentId, ws.id),
            eq(events.eventType, 'chat_message_completed'),
          ),
        )
        .orderBy(desc(events.createdAt))
        .limit(maxChatPerWs)
        .all();

      const sources: IndexableSource[] = [];
      for (const row of rows) {
        if (row.sensitivity === 'high') continue;
        // payload is a JSON string in SQLite (schema: text, default "{}").
        let content: unknown;
        try {
          content = (JSON.parse(row.payload) as { content?: unknown }).content;
        } catch {
          continue;
        }
        // N1: verbatim — no slice/substring on content.
        if (typeof content !== 'string' || content.length < 30) continue;
        sources.push({
          workspaceId: ws.id,
          sourceType: 'chat',
          sourceId: row.id,
          sourceVersion: typeof row.createdAt === 'number' ? row.createdAt : Number(row.createdAt),
          text: content,
          sensitivity: 'low',
        });
      }

      if (sources.length === 0) {
        // No content → skip, no log noise.
        continue;
      }

      // The loop-guard in indexBatch prevents a re-index storm (< 60s debounce).
      const result = await indexBatch(sources);
      totalWorkspacesIndexed += 1;
      totalChunks += result.indexed;

      if (result.indexed > 0 || result.failed > 0) {
        console.log(
          `[rag-auto-indexer] ${ws.id}: indexed=${result.indexed} skipped=${result.skipped} failed=${result.failed}`,
          result.reasons.length > 0 ? result.reasons.slice(0, 5) : '',
        );
      }
    } catch (err) {
      // Best-effort: one workspace error does not kill the rest.
      console.warn(`[rag-auto-indexer] ${ws.id}: error — skipping workspace`, err);
    }
  }

  console.log(
    `[rag-auto-indexer] done: workspaces=${totalWorkspacesIndexed}/${eligibleWorkspaces.length} chunks=${totalChunks}`,
  );

  // Self-heal (2026-06-03): catch up on sub-chat messages whose inline
  // ingest failed (ingested=0). Reuses the existing boot+interval
  // sweep instead of a separate timer — best-effort, never kills the boot index.
  try {
    const { reindexUningestedSubchats } = await import('@/lib/subchats/service');
    const heal = await reindexUningestedSubchats();
    if (heal.attempted > 0) {
      console.log(
        `[rag-auto-indexer] subchat self-heal: attempted=${heal.attempted} remaining=${heal.remaining}`,
      );
    }
  } catch (err) {
    console.warn('[rag-auto-indexer] subchat self-heal skipped:', err);
  }

  // Self-heal (2026-06-03, question-spinning): catch up on un-ingested question
  // answers (analogous to sub-chat messages). Best-effort, never kills the sweep.
  try {
    const { reindexUningestedAnswers } = await import('@/lib/subchats/questions-service');
    const n = await reindexUningestedAnswers();
    if (n > 0) {
      console.log(`[rag-auto-indexer] subchat-answer self-heal: reindexed=${n}`);
    }
  } catch (err) {
    console.warn('[rag-auto-indexer] subchat-answer self-heal skipped:', err);
  }

  // Auto-resolve (2026-06-03, question-spinning §5.2): set open sub-chat questions
  // that have already been answered lexically in the history to 'resolved'
  // (deterministic, no LLM). Best-effort.
  try {
    const { sweepStaleSubchatQuestions } = await import('@/lib/subchats/questions-resolve');
    const s = sweepStaleSubchatQuestions();
    if (s.resolved > 0) {
      console.log(`[rag-auto-indexer] subchat-question auto-resolve: ${s.resolved}/${s.scanned}`);
    }
  } catch (err) {
    console.warn('[rag-auto-indexer] subchat-question auto-resolve skipped:', err);
  }

  return { workspaces: totalWorkspacesIndexed, chunks: totalChunks };
}
