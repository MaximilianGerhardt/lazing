-- lazyOS Sprint X — workspace cloud (2026-04-27).
-- Per-workspace file cloud: up/download, folder hierarchy, AI generation,
-- surface cards. Works for every workspace; the sensitivity floor blocks
-- sensitive workspaces (private/example-app-*/demo-private) until phase-2 encryption.
--
-- Idempotent: IF NOT EXISTS throughout.
-- Soft-delete via deleted_at — no DROP ROW, so the audit/cleanup cron
-- can reconstruct the lifecycle.

CREATE TABLE IF NOT EXISTS cloud_artifacts (
  id                  TEXT    PRIMARY KEY,
  workspace_id        TEXT    NOT NULL,
  folder_id           TEXT,
  filename            TEXT    NOT NULL,
  mime                TEXT    NOT NULL,
  bytes               INTEGER NOT NULL,
  sha256              TEXT    NOT NULL,
  storage_path        TEXT    NOT NULL,
  encryption_version  INTEGER NOT NULL DEFAULT 0,
  pages               INTEGER,
  thumbnail_path      TEXT,
  metadata            TEXT,
  created_by          TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  deleted_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cloud_artifacts_workspace
  ON cloud_artifacts (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_artifacts_folder
  ON cloud_artifacts (workspace_id, folder_id, filename);

CREATE INDEX IF NOT EXISTS idx_cloud_artifacts_sha256
  ON cloud_artifacts (sha256);

CREATE INDEX IF NOT EXISTS idx_cloud_artifacts_deleted
  ON cloud_artifacts (deleted_at);

CREATE TABLE IF NOT EXISTS cloud_folders (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL,
  parent_id    TEXT,
  name         TEXT    NOT NULL,
  path         TEXT    NOT NULL,
  created_by   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cloud_folders_path
  ON cloud_folders (workspace_id, path);

CREATE INDEX IF NOT EXISTS idx_cloud_folders_parent
  ON cloud_folders (workspace_id, parent_id);

CREATE TABLE IF NOT EXISTS cloud_audit (
  id           TEXT    PRIMARY KEY,
  workspace_id TEXT    NOT NULL,
  artifact_id  TEXT,
  folder_id    TEXT,
  action       TEXT    NOT NULL,
  actor        TEXT    NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  metadata     TEXT,
  at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_audit_workspace
  ON cloud_audit (workspace_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_audit_artifact
  ON cloud_audit (artifact_id);
