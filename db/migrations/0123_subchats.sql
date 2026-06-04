-- 0123_subchats.sql — Workspace-Sub-Chats (Gathering-Intelligence-Goal, 2026-06-02)
-- Gruppenchats pro Workspace (extern Kunden via Share-Token / intern Team).
-- Jede Nachricht fließt als Wissen in die Workspace-RAG. Append-only, scoped (N2/N9).
-- Konvention: CREATE TABLE/INDEX IF NOT EXISTS (idempotent, Single-User-MVP).

CREATE TABLE IF NOT EXISTS subchats (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  title              TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'external',
  description        TEXT,
  created_by_user_id TEXT,
  share_token_hash   TEXT,
  share_expires_at   INTEGER,
  share_revoked_at   INTEGER,
  status             TEXT NOT NULL DEFAULT 'active',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subchats_workspace ON subchats (workspace_id);
CREATE INDEX IF NOT EXISTS idx_subchats_share_token ON subchats (share_token_hash);

CREATE TABLE IF NOT EXISTS subchat_messages (
  id           TEXT PRIMARY KEY,
  subchat_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  author_kind  TEXT NOT NULL,
  author_id    TEXT,
  author_name  TEXT,
  content      TEXT NOT NULL,
  ingested     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subchat_messages_subchat ON subchat_messages (subchat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subchat_messages_workspace ON subchat_messages (workspace_id);
CREATE INDEX IF NOT EXISTS idx_subchat_messages_ingest ON subchat_messages (ingested);
