/**
 * RAG indexer (Sprint 2 / strand B, 2026-04-30).
 *
 * 4 source types per workspace:
 *   - file         (workspace.path/**, gitignore-respect, max 200 KB per file)
 *   - chat         (events.payload.content for chat_message_completed)
 *   - ticket       (tickets.body + comments)
 *   - work-product (work_products.markdown)
 *
 * Privacy gate (mandatory):
 *   - segments with sensitivity='high' are skipped entirely
 *   - events with sensitivity='high' are skipped entirely
 *   - Keyword scan for high-sensitivity triggers (legal/financial terms,
 *     vault, finances) — skip on match.
 *
 * Loop-guard (required):
 *   1. Recursion detection: no re-index within < 60s
 *   2. Child-process isolation: the indexer runs only as a CLI script,
 *      NOT in the Next.js request path
 *   3. Circuit breaker: rag_indexer_state.circuit_open=1 after > 3 fails
 *      → the indexer pauses until a manual reset
 *
 * MAX-plan compliance: embedding is 100% local (Xenova).
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
 * Privacy gate (2026-04-30, Sprint 2 wave 4 fix):
 *
 * More precisely scoped — previously „password"/„secret"/„api_key" as bare
 * words led to false positives in CHANGELOG/README/middleware.ts
 * (65 files blocked for the lazyOS workspace).
 *
 * Now: only patterns that genuinely smell like a secret value
 *   - `secret = "..."` (assignment with a value)
 *   - `api_key = ...` with a value
 *   - Legal/financial sensitivity terms (Layer-3 vault triage)
 */
const HIGH_SENSITIVITY_PATTERNS: ReadonlyArray<RegExp> = [
  // Legal/Financial — sticky-sensitive terms
  /\bsteuerstrafverfahren\b/i,
  /\bsteuerstrafrecht\b/i,
  /\banwalt[-\s]mandat\b/i,
  /\bvermögensverhältnisse\b/i,
  /\binsolvenzverwalter\b/i,

  // Real secret strings — the pattern matches „X = "value"" or „X: 'value'"
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
  /** 'low' | 'med' — on 'high' the indexer throws (defense-in-depth). */
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
  // Hard-fail when workspaceId is missing — never fall back to "global" or
  // __root__. Defense-in-depth against caller bugs.
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

  // Idempotency: delete existing chunks for (workspace, source_type, source_id)
  // — we reindex the source completely from scratch.
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
      // A per-chunk error is non-fatal — we index the rest of the source
      console.warn('[rag-indexer] chunk-embed-fail:', err);
    }
  }
  return { inserted, skipped: chunks.length - inserted };
}

/**
 * Top-level: index a source bundle with loop-guard + circuit breaker.
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

  // Loop-guard 1: recursion detection (no re-index < 60s)
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

  // State update + loop-guard 3 (circuit-open after > 3 fails)
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
 * Convenience: reset the circuit breaker (after a manual fix).
 */
export function resetCircuit(workspaceId: string): void {
  const db = getDb();
  db.update(ragIndexerState)
    .set({ circuitOpen: 0, failedRuns: 0, updatedAt: Date.now() })
    .where(eq(ragIndexerState.workspaceId, workspaceId))
    .run();
}

/**
 * GDPR erasure: delete all rag_chunks of a source set (e.g. when a
 * sub-chat is hard-deleted). The FTS mirror follows automatically via the
 * AFTER-DELETE trigger `trg_rag_chunks_fts_delete`. Workspace-scoped (N2) —
 * never cross-workspace. Batched against the SQLite variable limit.
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
 * Reconciler: clean up orphaned subchat RAG chunks — `source_type='subchat'`
 * whose `source_id` (no longer) has a subchat_messages row. Catches historical
 * leaks (before the cascade fix) AND any future drift. FTS follows via trigger.
 * Suitable for a periodic sniper; idempotent.
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
