-- Phase ORG SP-1 — Memberships (2026-04-27).
-- User ↔ Organization (org_memberships) + User ↔ Workspace (workspace_memberships).
-- Workspace membership can override the org role (inherits_from_org=0).

CREATE TABLE IF NOT EXISTS org_memberships (
  id                 TEXT    PRIMARY KEY,
  user_id            TEXT    NOT NULL,
  org_id             TEXT    NOT NULL,
  role               TEXT    NOT NULL,
  invited_by_user_id TEXT,
  joined_at          INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orgmem_user ON org_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_orgmem_org  ON org_memberships (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_orgmem_user_org
  ON org_memberships (user_id, org_id);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  id                 TEXT    PRIMARY KEY,
  user_id            TEXT    NOT NULL,
  workspace_id       TEXT    NOT NULL,
  role               TEXT    NOT NULL,
  inherits_from_org  INTEGER NOT NULL DEFAULT 1,
  invited_by_user_id TEXT,
  joined_at          INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wsmem_user      ON workspace_memberships (user_id);
CREATE INDEX IF NOT EXISTS idx_wsmem_workspace ON workspace_memberships (workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wsmem_user_ws
  ON workspace_memberships (user_id, workspace_id);
