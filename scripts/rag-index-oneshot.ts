/**
 * One-Shot RAG-Indexer (Slice 1, 2026-05-23).
 *
 * Indiziert die Chat-History EINES Workspace in `rag_chunks`, damit der
 * Live-Chat (server/workspace-session.ts → retrieve()) tatsächlich Kontext
 * zieht. Bewusst NUR `chat`-Sources (Workspace-`path` ist in der lokalen DB
 * leer → File-Indexing liefert nichts). Heavy-Job: lädt den lokalen Embedder
 * (Xenova all-MiniLM-L6-v2, 384-dim) — daher als bewusster One-Shot, nicht im
 * Hot-Path.
 *
 * Usage:  tsx scripts/rag-index-oneshot.ts [workspaceId=default] [maxChat=300]
 */
import { getDb } from '../db/client';
import { indexBatch, type IndexableSource } from '../lib/rag/indexer';

async function main(): Promise<void> {
  const workspaceId = process.argv[2] ?? 'default';
  const maxChat = Number(process.argv[3] ?? 300);

  const db = getDb();
  const rows = db.$raw
    .prepare(
      `SELECT id, payload, sensitivity, created_at AS createdAt
         FROM events
        WHERE segment_id = ? AND event_type = 'chat_message_completed'
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(workspaceId, maxChat) as Array<{
    id: string;
    payload: string | null;
    sensitivity: string;
    createdAt: number;
  }>;

  const sources: IndexableSource[] = [];
  for (const row of rows) {
    if (row.sensitivity === 'high') continue;
    let content: unknown;
    try {
      content = JSON.parse(row.payload ?? '{}').content;
    } catch {
      continue;
    }
    if (typeof content !== 'string' || content.length < 30) continue;
    sources.push({
      workspaceId,
      sourceType: 'chat',
      sourceId: row.id,
      sourceVersion: row.createdAt,
      text: content,
      sensitivity: 'low',
    });
  }

  console.log(
    `[rag-oneshot] ${workspaceId}: ${sources.length} indizierbare chat-sources (aus ${rows.length} events)`,
  );
  if (sources.length === 0) {
    console.log('[rag-oneshot] NO-SOURCES — nichts zu indizieren.');
    return;
  }

  const result = await indexBatch(sources);
  console.log('[rag-oneshot] indexBatch result:', JSON.stringify(result));

  const cnt = db.$raw
    .prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE workspace_id = ?')
    .get(workspaceId) as { n: number };
  console.log(`[rag-oneshot] rag_chunks für ${workspaceId} jetzt: ${cnt.n}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[rag-oneshot] FATAL', e);
    process.exit(1);
  });
