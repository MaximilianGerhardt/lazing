-- Migration 0042 — RAG index per workspace (Sprint 2 / Strand B, 2026-04-30)
--
-- Local-first embeddings via Xenova/transformers.js (all-MiniLM-L6-v2,
-- 384-dim float32). NO API calls, NO cloud embeddings — MAX-plan compliant.
--
-- Storage model: BLOB column with packed float32 (4 bytes per dim ×
-- 384 = 1536 bytes per chunk). At ~10k chunks per workspace = 15 MB,
-- no problem in better-sqlite3.
--
-- Cosine similarity is computed in JS (lib/rag/embedder.ts) — no
-- sqlite-vss extension needed (would force a native build).
--
-- Privacy gate: sensitivity='high' chunks are NEVER indexed (see
-- B8 in the plan). The filter sits in the indexer, not in the DB — the DB holds only
-- what the indexer throws in.
--
-- Idempotent via the duplicate-table/column fallback in db/client.ts.

CREATE TABLE IF NOT EXISTS rag_chunks (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  source_type     TEXT NOT NULL,            -- 'file' | 'chat' | 'ticket' | 'work-product'
  source_id       TEXT NOT NULL,            -- path / event ID / ticket ID / WP ID
  source_version  INTEGER,                  -- optional: file mtime, event ts, etc.
  chunk_index     INTEGER NOT NULL,         -- order within the source
  text            TEXT NOT NULL,            -- original chunk (for re-indexing + audit)
  embedding       BLOB NOT NULL,            -- packed float32 × 384
  token_count     INTEGER,                  -- approx token count (for the budget cap)
  sensitivity     TEXT NOT NULL DEFAULT 'low',  -- 'low' | 'med' (high NEVER in the index)
  indexed_at      INTEGER NOT NULL,
  expires_at      INTEGER                   -- optional: auto-purge after N days
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_workspace ON rag_chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_source    ON rag_chunks (workspace_id, source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_indexed   ON rag_chunks (workspace_id, indexed_at DESC);

-- Indexer state per workspace: how far have we indexed?
-- Prevents double-indexing + enables incremental re-index.
CREATE TABLE IF NOT EXISTS rag_indexer_state (
  workspace_id      TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  last_indexed_id   TEXT,
  last_indexed_ts   INTEGER NOT NULL,
  total_chunks      INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  failed_runs       INTEGER NOT NULL DEFAULT 0,
  circuit_open      INTEGER NOT NULL DEFAULT 0,  -- Loop-Guard: bei Fail > N → 1
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_type)
);
