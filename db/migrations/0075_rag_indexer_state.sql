-- ============================================================
-- 0075_rag_indexer_state.sql — Slice-B M-RAG-03
-- Idempotent indexing metadata. Atomic UPSERT (F-IDEM-01 fix).
-- Authority: modules/W2/M-RAG-03/INDEXER-STATE-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0072)
-- Depends on: 0074 rag_chunks scope columns existence.
-- ============================================================
CREATE TABLE IF NOT EXISTS rag_indexer_state (
  id              TEXT PRIMARY KEY NOT NULL,

  source_path     TEXT NOT NULL,

  last_indexed_at TEXT NOT NULL,

  last_hash       TEXT NOT NULL,

  chunk_count     INTEGER NOT NULL CHECK (chunk_count >= 0),

  scope_kind      TEXT NOT NULL CHECK (scope_kind IN ('personal','org','workspace','project')),
  scope_id        TEXT NOT NULL,

  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  UNIQUE (source_path, scope_kind, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_rag_indexer_state_scope
  ON rag_indexer_state (scope_kind, scope_id, last_indexed_at DESC);

DROP TRIGGER IF EXISTS rag_indexer_state_set_updated_at;
CREATE TRIGGER rag_indexer_state_set_updated_at
AFTER UPDATE ON rag_indexer_state
FOR EACH ROW
BEGIN
  UPDATE rag_indexer_state
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id = OLD.id;
END;
