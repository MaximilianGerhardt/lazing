-- ============================================================
-- 0074_rag_chunks_scope.sql — Slice-B M-RAG-01
-- Additive Scope-Envelope-Spalten auf rag_chunks (N2 + N9 + POS-2).
-- Authority: modules/W2/M-RAG-01/RAG-CHUNKS-SCOPE-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0071)
-- POS-2: Scope-Envelope per chunk via NOT-NULL via Trigger (ALTER limit).
-- ============================================================
PRAGMA foreign_keys = ON;

-- For fresh-DB bootstrapping: create rag_chunks if missing with scope cols inline.
-- On an inherited lazyOS-DB the ALTER-TABLE-ADD-COLUMN path applies (idempotent
-- via Migration-Runner's user_version gate; this CREATE is a no-op if table exists).
CREATE TABLE IF NOT EXISTS rag_chunks (
  id              TEXT PRIMARY KEY NOT NULL,
  workspace_id    TEXT,
  scope_kind      TEXT,
  scope_id        TEXT,
  source_path     TEXT,
  content         TEXT NOT NULL,
  metadata        TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- BEFORE-INSERT trigger: every new row needs scope_kind+scope_id+workspace_id.
CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_require_scope
BEFORE INSERT ON rag_chunks
FOR EACH ROW
WHEN NEW.scope_kind IS NULL
  OR NEW.scope_id IS NULL
  OR NEW.workspace_id IS NULL
  OR NEW.scope_kind NOT IN ('personal', 'org', 'workspace', 'project')
BEGIN
  SELECT RAISE(ABORT,
    'M-RAG-01/N2: rag_chunks row rejected — scope_kind+scope_id+workspace_id required, scope_kind must be one of personal|org|workspace|project');
END;

-- BEFORE-UPDATE-Trigger: scope_kind/scope_id/workspace_id immutable (N9).
CREATE TRIGGER IF NOT EXISTS trg_rag_chunks_scope_immutable
BEFORE UPDATE OF scope_kind, scope_id, workspace_id ON rag_chunks
FOR EACH ROW
WHEN (OLD.scope_kind IS NOT NEW.scope_kind)
  OR (OLD.scope_id IS NOT NEW.scope_id)
  OR (OLD.workspace_id IS NOT NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT,
    'M-RAG-01/N9: scope_kind/scope_id/workspace_id are immutable post-INSERT (N9 identity)');
END;

-- Hot-path indices.
CREATE INDEX IF NOT EXISTS ix_rag_chunks_scope
  ON rag_chunks (scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS ix_rag_chunks_workspace
  ON rag_chunks (workspace_id);

CREATE INDEX IF NOT EXISTS ix_rag_chunks_scope_created
  ON rag_chunks (scope_kind, scope_id, created_at);

PRAGMA user_version = 74;
