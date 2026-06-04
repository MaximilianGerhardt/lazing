-- Phase ORG+1 — per-workspace encryption key (wrapped DEK).
-- 2026-04-28.
-- DEK = data-encryption key (32 bytes AES-256), wrapped with the master KEK.
-- The master KEK lives in env (LAZYOS_MASTER_KEK), never in the DB.

CREATE TABLE IF NOT EXISTS workspace_keys (
  id            TEXT    PRIMARY KEY,
  workspace_id  TEXT    NOT NULL,
  wrapped_dek   TEXT    NOT NULL,
  key_version   INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  rotated_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wskeys_workspace ON workspace_keys (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wskeys_active
  ON workspace_keys (workspace_id, key_version);
