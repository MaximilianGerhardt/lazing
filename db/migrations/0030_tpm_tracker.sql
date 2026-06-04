-- Phase QA · 2026-04-28
-- TPM tracker for global tokens-per-minute budget management.
--
-- Every Anthropic API interaction (workspace-session, tier-spawn, runIterate)
-- writes an entry with input/output token counts. The TPM budget lib
-- reads rolling 60s-window aggregates to decide whether new spawns
-- are safe (ahead of the Anthropic TPM throttle).
--
-- Cleanup: rows older than 5min are deleted automatically on every read tick.
-- No cron needed.

CREATE TABLE IF NOT EXISTS tpm_tracker (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,        -- Unix-ms
  source          TEXT NOT NULL,           -- 'workspace-session' | 'tier-spawn' | 'iterate-lead' | 'iterate-roaster' | 'auto-dispatch-stage' | 'manual'
  workspace_id    TEXT,                    -- optional, für Diagnostics
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tpm_tracker_ts ON tpm_tracker (ts DESC);
