-- Phase ORG+2 — share tokens for external stakeholders (2026-04-28).
-- Public read on individual cloud artifacts without login.
-- Token = 32 random bytes, only the SHA-256 hash stored in the DB.

CREATE TABLE IF NOT EXISTS share_tokens (
  id                   TEXT    PRIMARY KEY,
  token_hash           TEXT    NOT NULL UNIQUE,
  artifact_id          TEXT    NOT NULL,
  workspace_id         TEXT    NOT NULL,
  created_by_user_id   TEXT,
  password_hash        TEXT,
  expires_at           INTEGER NOT NULL,
  max_views            INTEGER,
  current_views        INTEGER NOT NULL DEFAULT 0,
  revoked_at           INTEGER,
  revoked_by_user_id   TEXT,
  created_at           INTEGER NOT NULL,
  last_viewed_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_share_artifact   ON share_tokens (artifact_id);
CREATE INDEX IF NOT EXISTS idx_share_expires    ON share_tokens (expires_at);
CREATE INDEX IF NOT EXISTS idx_share_workspace  ON share_tokens (workspace_id);
