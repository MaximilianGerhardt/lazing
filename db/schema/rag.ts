/**
 * RAG index schema (Sprint 2 / Strand B, 2026-04-30).
 *
 * Local-first embeddings, stored as a packed float32 BLOB.
 * Cosine similarity is computed in JS — no sqlite-vss native
 * extension. At < 50k chunks per workspace, brute-force cosine is
 * under 30ms (benchmark in lib/rag/embedder.test.ts).
 *
 * Privacy gate: sensitivity='high' is NEVER stored in the index.
 * The indexer filter sits in lib/rag/indexer.ts.
 */

import { sql } from 'drizzle-orm';
import {
  blob,
  integer,
  sqliteTable,
  sqliteView,
  text,
} from 'drizzle-orm/sqlite-core';

export const ragChunks = sqliteTable('rag_chunks', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull(),
  /** 'file' | 'chat' | 'ticket' | 'work-product' */
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  /** Optional: file mtime, event ts, ticket version, etc. */
  sourceVersion: integer('source_version'),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  /** packed float32 × 384 (1536 bytes for all-MiniLM-L6-v2). */
  embedding: blob('embedding', { mode: 'buffer' }).notNull(),
  /** Approx token count (budget cap in the retriever). */
  tokenCount: integer('token_count'),
  /** 'low' | 'med' (high NEVER in the index — privacy gate). */
  sensitivity: text('sensitivity').notNull().default('low'),
  indexedAt: integer('indexed_at').notNull(),
  /** Optional: auto-purge after N days. */
  expiresAt: integer('expires_at'),
});

export const ragIndexerState = sqliteTable('rag_indexer_state', {
  workspaceId: text('workspace_id').notNull(),
  sourceType: text('source_type').notNull(),
  lastIndexedId: text('last_indexed_id'),
  lastIndexedTs: integer('last_indexed_ts').notNull(),
  totalChunks: integer('total_chunks').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  failedRuns: integer('failed_runs').notNull().default(0),
  /** Loop guard: on fail > N → 1 (indexer pauses). */
  circuitOpen: integer('circuit_open').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export type RagChunkRow = typeof ragChunks.$inferSelect;
export type RagChunkInsert = typeof ragChunks.$inferInsert;
export type RagIndexerStateRow = typeof ragIndexerState.$inferSelect;

// Drizzle compound-PK hint (sql-tag, since DrizzleORM 0.45 has no
// composite-primary-key helper).
export const ragIndexerStatePk = sql`PRIMARY KEY (workspace_id, source_type)`;

/**
 * Workspace-isolated read view (migration 0052, phase 2 service refactor).
 *
 * Defense-in-depth:
 *   - INNER JOIN on workspaces — orphan chunks invisible.
 *   - sensitivity != 'high' hard-wired into the view.
 *
 * **Service contract:** the caller MUST additionally append `WHERE workspace_id = ?`
 * — the view is belt-and-suspenders, not the filter itself.
 *
 * `.existing()` marks the view as already existing in the DB (migration
 * 0052) — Drizzle does not try to recreate the view.
 */
export const vRagChunksWorkspace = sqliteView('v_rag_chunks_workspace', {
  id: text('id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  sourceType: text('source_type').notNull(),
  sourceId: text('source_id').notNull(),
  sourceVersion: integer('source_version'),
  chunkIndex: integer('chunk_index').notNull(),
  text: text('text').notNull(),
  embedding: blob('embedding', { mode: 'buffer' }).notNull(),
  tokenCount: integer('token_count'),
  sensitivity: text('sensitivity').notNull(),
  indexedAt: integer('indexed_at').notNull(),
  expiresAt: integer('expires_at'),
}).existing();

/**
 * Cross-workspace audit (migration 0052) — GDPR Art. 30 RoPA.
 *
 * Every successful `retrieveAcrossWorkspaces()` call as well as every
 * downgraded MCP knowledge-base hit writes an entry here.
 */
export const ragCrossWorkspaceAudit = sqliteTable(
  'rag_cross_workspace_audit',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    query: text('query').notNull(),
    /** JSON array of the workspace_ids in the result. */
    workspacesSeen: text('workspaces_seen').notNull(),
    hits: integer('hits').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  },
);

export type RagCrossWorkspaceAuditRow =
  typeof ragCrossWorkspaceAudit.$inferSelect;
