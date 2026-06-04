-- lazyOS Sprint 2 · Section 7C — Workspaces-Tabelle
-- Replaces the segment concept with real projects (discover-workspaces.ts).
-- Idempotent: can run multiple times.

CREATE TABLE IF NOT EXISTS workspaces (
  id                 TEXT PRIMARY KEY,
  label              TEXT NOT NULL,
  accent             TEXT NOT NULL,
  path               TEXT NOT NULL,
  sensitivity        TEXT NOT NULL DEFAULT 'low',
  archived           INTEGER NOT NULL DEFAULT 0,
  credential_owner   TEXT,
  description        TEXT,
  org_chart          TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspaces_id       ON workspaces (id);
CREATE INDEX IF NOT EXISTS idx_workspaces_archived ON workspaces (archived);
