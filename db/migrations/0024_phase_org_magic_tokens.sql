-- Phase ORG SP-1 — magic-link tokens (schema only in phase 1, routes come in SP-3).
-- token_hash is SHA-256(token). Plaintext is NEVER stored.
-- GDPR: retention 24h after use (purge_after field), prunable via cron.

CREATE TABLE IF NOT EXISTS magic_tokens (
  id                   TEXT    PRIMARY KEY,
  token_hash           TEXT    NOT NULL UNIQUE,
  email                TEXT    NOT NULL,
  intent               TEXT    NOT NULL,
  intent_org_id        TEXT,
  intent_workspace_id  TEXT,
  intent_role          TEXT,
  issued_by_user_id    TEXT,
  issued_at            INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  consumed_at          INTEGER,
  consumed_ip          TEXT,
  consumed_user_agent  TEXT,
  purge_after          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_magic_email ON magic_tokens (email);
CREATE INDEX IF NOT EXISTS idx_magic_purge ON magic_tokens (purge_after);
