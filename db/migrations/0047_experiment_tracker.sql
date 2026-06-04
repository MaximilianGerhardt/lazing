-- Migration 0047 — Experiment-Tracker (Echter Pattern 9 "Unlearning", 2026-05-01)
--
-- Correction from user feedback 2026-05-01: Anne (Legaly-AI) means by "to unlearn"
-- a PERSONAL WORK ATTITUDE (discard assumptions, experiment more),
-- NOT file cleanup. The old `lib/unlearning/` (file cleanup) is now renamed to
-- `lib/stale-detection/`. This table persists real failed
-- experiments so the weekly-retry-sniper can re-trigger them after 14d with the current
-- model + a fresh perspective.
--
-- Use case: a sub-spawn fails ("quality not good enough" / "doesn't work
-- for this use case"). Instead of archiving → recordFailedExperiment().
-- Sundays 21:00 the weekly-retry-sniper runs, loads unresolved experiments older
-- than 14d, re-spawns them, compares the output. On success → sub-ticket
-- "solution found — previously failed at <ts>".

CREATE TABLE IF NOT EXISTS failed_experiments (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT,
  -- What was tried (max 500 chars, longer is truncated)
  hypothesis      TEXT NOT NULL,
  -- Why it failed (free text, quality note, error stub)
  failure_reason  TEXT,
  -- Unix-ms of the original attempt
  attempted_at    INTEGER NOT NULL,
  -- Model ID (claude-opus-4-7 etc.) at the time of the original attempt
  model_used      TEXT,
  -- How many retry attempts there were (counted up by the sniper)
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_retry_at   INTEGER,
  -- NULL = unresolved, set = resolved
  resolved_at     INTEGER,
  resolution_note TEXT,
  -- Optional: link with the workstream/ticket the experiment came from
  workstream_id   TEXT,
  ticket_id       TEXT
);

-- Index for `loadUnresolvedExperiments(maxAgeDays)`: filter resolved IS NULL
-- + sort attempted_at DESC.
CREATE INDEX IF NOT EXISTS idx_failed_experiments_unresolved
  ON failed_experiments(resolved_at, attempted_at DESC);

-- Index for workspace-scoped queries (UI: "all failed experiments of this WS").
CREATE INDEX IF NOT EXISTS idx_failed_experiments_workspace
  ON failed_experiments(workspace_id, attempted_at DESC);
