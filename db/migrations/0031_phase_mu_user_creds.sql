-- Phase MU.1 · 2026-04-28
-- Multi-User-MAX-Plan-Tokens.
--
-- Goal: each user can optionally couple their own Claude-MAX plan,
-- instead of sharing Max's token. This avoids TPM
-- collisions and enables real parallel usage.
--
-- Status values:
--   'shared' (default): the user uses system credentials (Max's MAX plan)
--   'own': the user uploaded their own credentials.json
--   'none': the user actively declined — all spawns fail for them
--
-- Security:
--   claude_max_creds_path points to an encrypted-at-rest file in
--   ~/.lazyos/user-creds/<userId>/credentials.json.enc
--   Encryption with AES-256-GCM (see Phase ORG+1 KEK wrapping).
--   We store ONLY the path here, never the credentials themselves.
--
-- claude_max_email is intended only for diagnostics ("which account is connected?").
-- It is extracted from credentials.json on upload (oauthAccount).

ALTER TABLE users ADD COLUMN claude_max_creds_path TEXT;
ALTER TABLE users ADD COLUMN claude_max_status TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE users ADD COLUMN claude_max_email TEXT;
ALTER TABLE users ADD COLUMN claude_max_updated_at INTEGER;
