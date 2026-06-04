-- lazyOS Sprint 2 · Stream E — Routines-Engine
-- Proaktive, YAML-konfigurierte Auto-Runs (Cron/Manual/Event).
-- Idempotent: kann mehrfach laufen.

CREATE TABLE IF NOT EXISTS routines (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  yaml_config    TEXT NOT NULL,
  trigger_mode   TEXT NOT NULL DEFAULT 'manual',
  cron_expr      TEXT,
  event_match    TEXT,
  last_run_at    INTEGER,
  next_run_at    INTEGER,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_routines_workspace ON routines (workspace_id);
CREATE INDEX IF NOT EXISTS idx_routines_active    ON routines (active);
CREATE INDEX IF NOT EXISTS idx_routines_next_run  ON routines (active, next_run_at ASC);

CREATE TABLE IF NOT EXISTS routine_runs (
  id             TEXT PRIMARY KEY,
  routine_id     TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  status         TEXT NOT NULL,
  output         TEXT,
  error          TEXT,
  delivery_ref   TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_routine_started
  ON routine_runs (routine_id, started_at DESC);
