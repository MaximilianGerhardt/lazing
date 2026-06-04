-- lazyOS Sprint 2 · Section 7D — Workspace-Heartbeats
-- Per-Workspace-Gesundheits-Snapshots (Git-Probes) — append-only.
-- Idempotent: kann mehrfach laufen.

CREATE TABLE IF NOT EXISTS workspace_heartbeats (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  status          TEXT NOT NULL,
  lag_sec         INTEGER NOT NULL,
  probes          TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_workspace_ts
  ON workspace_heartbeats (workspace_id, ts DESC);
