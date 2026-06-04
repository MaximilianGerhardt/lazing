-- Phase MU.4 · 2026-04-28
-- TPM tracking per user. With `claude_max_status='own'` each user has their
-- own Anthropic quota — the global rolling-60s aggregates then
-- no longer make sense. The user_id column enables filtered aggregates per user.
--
-- NULL = system/shared Spawn (legacy + Default).

ALTER TABLE tpm_tracker ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tpm_tracker_user ON tpm_tracker (user_id, ts DESC);
