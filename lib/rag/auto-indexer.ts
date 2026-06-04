/**
 * RAG-Auto-Indexer (2026-05-24).
 *
 * Befüllt `rag_chunks` für ALLE nicht-archivierten, nicht-high-sensitivity
 * Workspaces mit chat-Sources — damit RAG-in-Chat beim Boot tatsächlich
 * Kontext liefert (sonst: 0 Chunks → retrieve() liefert immer leer).
 *
 * Design-Entscheidungen:
 *   - Fire-and-forget: wird aus instrumentation.ts via setTimeout (30s nach
 *     Boot) gestartet, blockiert NICHT den Server-Start.
 *   - Best-effort: ein Fehler pro Workspace killt nicht den Rest.
 *   - Loop-Guard: indexBatch() hat eingebaute 60s-Debounce + Circuit-Breaker
 *     via rag_indexer_state — kein Re-Index-Sturm möglich.
 *   - Kein File-Indexing: workspace.path ist auf dem VPS oft leer/extern.
 *     chat-Sources sind die unmittelbar nützliche Quelle für RAG-in-Chat.
 *   - N2-konform: kein Cross-Workspace-Abruf, jede Source trägt ihre
 *     workspaceId explizit.
 *   - N1-konform: payload.content wird verbatim an indexBatch übergeben,
 *     kein .slice / .substring.
 *
 * Exports:
 *   indexAllWorkspaces(opts?) — Public API, auch direkt per Script aufrufbar.
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
 * Indexiert die Chat-History aller aktiven, nicht-high-sensitivity Workspaces.
 *
 * @param opts.maxChatPerWs - Max chat_message_completed Events pro Workspace (Default 300).
 * @returns Anzahl verarbeitete Workspaces + total neue Chunks.
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

  // Privacy-Gate: high-sensitivity Workspaces niemals indexieren.
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
      // Chat-Sources sammeln — identische Logik wie app/api/rag/index/route.ts.
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
        // payload ist in SQLite ein JSON-String (schema: text, default "{}").
        let content: unknown;
        try {
          content = (JSON.parse(row.payload) as { content?: unknown }).content;
        } catch {
          continue;
        }
        // N1: verbatim — kein slice/substring auf content.
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
        // Kein Content → skip, kein Log-Noise.
        continue;
      }

      // Loop-Guard in indexBatch verhindert Re-Index-Sturm (< 60s debounce).
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
      // Best-effort: ein Workspace-Fehler killt nicht den Rest.
      console.warn(`[rag-auto-indexer] ${ws.id}: error — skipping workspace`, err);
    }
  }

  console.log(
    `[rag-auto-indexer] done: workspaces=${totalWorkspacesIndexed}/${eligibleWorkspaces.length} chunks=${totalChunks}`,
  );

  // Self-Heal (2026-06-03): Sub-Chat-Nachrichten nachziehen, deren Inline-
  // Ingest fehlschlug (ingested=0). Reuse des bestehenden boot+Intervall-
  // Sweeps statt eigenem Timer — best-effort, killt den Boot-Index nie.
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

  // Self-Heal (2026-06-03, Question-Spinning): nicht-ingestete Frage-Antworten
  // nachziehen (analog Sub-Chat-Nachrichten). Best-effort, killt den Sweep nie.
  try {
    const { reindexUningestedAnswers } = await import('@/lib/subchats/questions-service');
    const n = await reindexUningestedAnswers();
    if (n > 0) {
      console.log(`[rag-auto-indexer] subchat-answer self-heal: reindexed=${n}`);
    }
  } catch (err) {
    console.warn('[rag-auto-indexer] subchat-answer self-heal skipped:', err);
  }

  // Auto-Resolve (2026-06-03, Question-Spinning §5.2): offene Sub-Chat-Fragen,
  // die im Verlauf bereits lexical beantwortet wurden, auf 'resolved' setzen
  // (deterministisch, kein LLM). Best-effort.
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
