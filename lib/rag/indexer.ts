/**
 * RAG-Indexer (Sprint 2 / Strang B, 2026-04-30).
 *
 * Pro Workspace 4 Source-Types:
 *   - file         (workspace.path/**, gitignore-respect, max 200 KB pro File)
 *   - chat         (events.payload.content für chat_message_completed)
 *   - ticket       (tickets.body + comments)
 *   - work-product (work_products.markdown)
 *
 * Privacy-Gate (Pflicht):
 *   - segments mit sensitivity='high' werden komplett übersprungen
 *   - events mit sensitivity='high' werden komplett übersprungen
 *   - Keyword scan for high-sensitivity triggers (legal/financial terms,
 *     vault, finances) — skip on match.
 *
 * Loop-Guard (required):
 *   1. Recursion-Detection: kein Re-Index innerhalb < 60s
 *   2. Child-Process-Isolation: Indexer läuft nur als CLI-Script,
 *      NICHT in Next.js-Request-Path
 *   3. Circuit-Breaker: rag_indexer_state.circuit_open=1 nach > 3 Fails
 *      → Indexer pausiert bis manueller Reset
 *
 * MAX-Plan-Konformität: Embedding ist 100% lokal (Xenova).
 */

import { ulid } from '@/lib/ulid';
import { getDb } from '@/db/client';
import { ragChunks, ragIndexerState } from '@/db/schema/rag';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { chunkText, type Chunk } from './chunker';
import { embed, packEmbedding } from './embedder';
import { RagWorkspaceRequiredError } from './retriever';

function assertWorkspaceId(workspaceId: unknown): asserts workspaceId is string {
  if (
    typeof workspaceId !== 'string' ||
    workspaceId.length === 0 ||
    workspaceId.trim().length === 0
  ) {
    throw new RagWorkspaceRequiredError(
      'rag-indexer: workspaceId is required (DSGVO Art. 28 mandant-trennung)',
    );
  }
}

/**
 * Privacy-Gate (2026-04-30, Sprint 2 Welle 4 fix):
 *
 * Genauer abgegrenzt — vorher hat „password"/„secret"/„api_key" als bare
 * Wörter zu false-positives in CHANGELOG/README/middleware.ts geführt
 * (65 Files geblockt für lazyOS-Workspace).
 *
 * Jetzt: nur Patterns die echt nach Geheimnis-Wert riechen
 *   - `secret = "..."` (Zuweisung mit Wert)
 *   - `api_key = ...` mit Wert
 *   - Legal/financial sensitivity terms (Layer-3 vault triage)
 */
const HIGH_SENSITIVITY_PATTERNS: ReadonlyArray<RegExp> = [
  // Legal/Financial — sticky-sensitive terms
  /\bsteuerstrafverfahren\b/i,
  /\bsteuerstrafrecht\b/i,
  /\banwalt[-\s]mandat\b/i,
  /\bvermögensverhältnisse\b/i,
  /\binsolvenzverwalter\b/i,

  // Echte Secret-Strings — Pattern matcht „X = "value"" oder „X: 'value'"
  /\b(?:secret|api[_-]?key|access[_-]?token|password|pwd)\s*[=:]\s*["'][^"']{8,}["']/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,         // AWS Access-Key-ID
  /sk-[A-Za-z0-9]{20,}/,      // OpenAI/Anthropic API-Key-Pattern
];

export type IndexerSourceType = 'file' | 'chat' | 'ticket' | 'work-product' | 'subchat';

export interface IndexableSource {
  workspaceId: string;
  sourceType: IndexerSourceType;
  sourceId: string;
  sourceVersion?: number;
  text: string;
  /** 'low' | 'med' — bei 'high' wirft der Indexer (Defense-in-Depth). */
  sensitivity?: 'low' | 'med' | 'high';
}

export interface IndexResult {
  workspaceId: string;
  indexed: number;
  skipped: number;
  failed: number;
  reasons: string[];
}

function isSensitiveText(text: string): boolean {
  return HIGH_SENSITIVITY_PATTERNS.some((re) => re.test(text));
}

export async function indexSource(source: IndexableSource): Promise<{
  inserted: number;
  skipped: number;
  reason?: string;
}> {
  // Hard-Fail wenn workspaceId fehlt — niemals auf "global" oder __root__
  // fallback-en. Defense-in-Depth gegen Caller-Bugs.
  assertWorkspaceId(source.workspaceId);
  if (source.sensitivity === 'high') {
    return { inserted: 0, skipped: 1, reason: 'sensitivity-high-block' };
  }
  if (isSensitiveText(source.text)) {
    return { inserted: 0, skipped: 1, reason: 'high-keyword-block' };
  }
  if (source.text.length < 30) {
    return { inserted: 0, skipped: 1, reason: 'too-short' };
  }

  const chunks: Chunk[] = chunkText(source.text);
  if (chunks.length === 0) {
    return { inserted: 0, skipped: 1, reason: 'no-chunks' };
  }

  const db = getDb();
  const now = Date.now();

  // Idempotenz: Vorhandene Chunks für (workspace, source_type, source_id)
  // löschen — wir reindexen die Source komplett neu.
  db.delete(ragChunks)
    .where(
      and(
        eq(ragChunks.workspaceId, source.workspaceId),
        eq(ragChunks.sourceType, source.sourceType),
        eq(ragChunks.sourceId, source.sourceId),
      ),
    )
    .run();

  let inserted = 0;
  for (const chunk of chunks) {
    try {
      const vec = await embed(chunk.text);
      db.insert(ragChunks)
        .values({
          id: ulid(),
          workspaceId: source.workspaceId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          sourceVersion: source.sourceVersion ?? null,
          chunkIndex: chunk.index,
          text: chunk.text,
          embedding: packEmbedding(vec),
          tokenCount: chunk.approxTokens,
          sensitivity: source.sensitivity ?? 'low',
          indexedAt: now,
          expiresAt: null,
        })
        .run();
      inserted += 1;
    } catch (err) {
      // Pro-Chunk-Fehler nicht-fatal — wir indexieren den Rest der Source
      console.warn('[rag-indexer] chunk-embed-fail:', err);
    }
  }
  return { inserted, skipped: chunks.length - inserted };
}

/**
 * Top-Level: Source-Bündel indexen mit Loop-Guard + Circuit-Breaker.
 */
export async function indexBatch(
  sources: IndexableSource[],
): Promise<IndexResult> {
  if (sources.length === 0) {
    return {
      workspaceId: '',
      indexed: 0,
      skipped: 0,
      failed: 0,
      reasons: ['empty-batch'],
    };
  }
  const workspaceId = sources[0].workspaceId;
  assertWorkspaceId(workspaceId);

  // Loop-Guard 1: Recursion-Detection (kein Re-Index < 60s)
  const db = getDb();
  const stateRow = db
    .select()
    .from(ragIndexerState)
    .where(
      and(
        eq(ragIndexerState.workspaceId, workspaceId),
        eq(ragIndexerState.sourceType, 'all'),
      ),
    )
    .limit(1)
    .all();
  const state = stateRow[0];
  const now = Date.now();
  if (state?.circuitOpen) {
    return {
      workspaceId,
      indexed: 0,
      skipped: 0,
      failed: sources.length,
      reasons: ['circuit-open'],
    };
  }
  if (state && now - state.lastIndexedTs < 60_000) {
    return {
      workspaceId,
      indexed: 0,
      skipped: sources.length,
      failed: 0,
      reasons: ['recursion-debounce-60s'],
    };
  }

  let indexed = 0;
  let skipped = 0;
  let failed = 0;
  const reasons: string[] = [];

  for (const source of sources) {
    try {
      const r = await indexSource(source);
      indexed += r.inserted;
      skipped += r.skipped;
      if (r.reason) reasons.push(`${source.sourceType}/${source.sourceId}:${r.reason}`);
    } catch (err) {
      failed += 1;
      reasons.push(
        `${source.sourceType}/${source.sourceId}:fatal:${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // State-Update + Loop-Guard 3 (Circuit-Open bei > 3 Fails)
  const newFailedRuns = (state?.failedRuns ?? 0) + (failed > 0 ? 1 : 0);
  const circuitOpen = newFailedRuns > 3 ? 1 : 0;
  const upsertValues = {
    workspaceId,
    sourceType: 'all',
    lastIndexedId: null,
    lastIndexedTs: now,
    totalChunks: (state?.totalChunks ?? 0) + indexed,
    totalTokens: state?.totalTokens ?? 0,
    failedRuns: newFailedRuns,
    circuitOpen,
    updatedAt: now,
  };
  if (state) {
    db.update(ragIndexerState)
      .set(upsertValues)
      .where(
        and(
          eq(ragIndexerState.workspaceId, workspaceId),
          eq(ragIndexerState.sourceType, 'all'),
        ),
      )
      .run();
  } else {
    db.insert(ragIndexerState).values(upsertValues).run();
  }

  return { workspaceId, indexed, skipped, failed, reasons };
}

/**
 * Convenience: Reset Circuit-Breaker (nach manuellem Fix).
 */
export function resetCircuit(workspaceId: string): void {
  const db = getDb();
  db.update(ragIndexerState)
    .set({ circuitOpen: 0, failedRuns: 0, updatedAt: Date.now() })
    .where(eq(ragIndexerState.workspaceId, workspaceId))
    .run();
}

/**
 * GDPR-Erasure: alle rag_chunks einer Source-Menge löschen (z.B. wenn ein
 * Sub-Chat hart gelöscht wird). Der FTS-Mirror folgt automatisch via dem
 * AFTER-DELETE-Trigger `trg_rag_chunks_fts_delete`. Workspace-gescoped (N2) —
 * niemals Cross-Workspace. Gebatcht gegen das SQLite-Variablen-Limit.
 */
export function deleteSourceChunks(
  workspaceId: string,
  sourceType: string,
  sourceIds: string[],
): number {
  assertWorkspaceId(workspaceId);
  if (sourceIds.length === 0) return 0;
  const db = getDb();
  let deleted = 0;
  for (let i = 0; i < sourceIds.length; i += 400) {
    const batch = sourceIds.slice(i, i + 400);
    const res = db
      .delete(ragChunks)
      .where(
        and(
          eq(ragChunks.workspaceId, workspaceId),
          eq(ragChunks.sourceType, sourceType),
          inArray(ragChunks.sourceId, batch),
        ),
      )
      .run();
    deleted += res.changes ?? 0;
  }
  return deleted;
}

/**
 * Reconciler: verwaiste Subchat-RAG-Chunks aufräumen — `source_type='subchat'`
 * deren `source_id` keine subchat_messages-Row (mehr) hat. Fängt historische
 * Leaks (vor dem Cascade-Fix) UND jeden zukünftigen Drift. FTS folgt via Trigger.
 * Für einen periodischen Sniper geeignet; idempotent.
 */
export function purgeOrphanSubchatChunks(): { deleted: number } {
  const db = getDb();
  const res = db.run(
    sql`DELETE FROM rag_chunks
        WHERE source_type = 'subchat'
          AND source_id NOT IN (SELECT id FROM subchat_messages)`,
  );
  return { deleted: (res as { changes?: number }).changes ?? 0 };
}
