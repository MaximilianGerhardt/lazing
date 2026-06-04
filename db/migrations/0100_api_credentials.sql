-- ============================================================
-- 0100_api_credentials.sql — Generic API-Credential-Vault (ACL-1)
--
-- Two tables:
--   `api_credentials`      — encrypted credentials per scope+provider
--   `credential_access_log` — append-only audit log (N8)
--
-- Design decisions:
--   - scope_kind CHECK('org','workspace') — exactly two levels, no wildcard.
--   - UNIQUE(scope_kind, scope_id, provider) — one credential per scope+provider.
--   - encrypted_secret AES-256-GCM via lib/security/credentials.ts (LAZYOS_CREDENTIAL_KEY).
--   - content_hash SHA-256 over canonical JSON (N10 tamper evidence).
--   - credential_access_log has NO FK on api_credentials — append-only,
--     the audit remains even after a credential delete.
--   - Idempotent via IF NOT EXISTS (laz.ing migration convention).
--
-- Isolation guarantee (N9):
--   All queries MUST set scope_kind + scope_id as the WHERE anchor.
--   The resolver enforces this via lib/credentials/vault.ts.
-- ============================================================

-- Primary credential vault
CREATE TABLE IF NOT EXISTS api_credentials (
  id                   TEXT PRIMARY KEY,
  -- 'org' | 'workspace'
  scope_kind           TEXT NOT NULL CHECK(scope_kind IN ('org', 'workspace')),
  -- org_id OR workspace_id depending on scope_kind
  scope_id             TEXT NOT NULL,
  -- Provider identifier, e.g. 'heygen', 'openai', 'anthropic', 'stripe'
  provider             TEXT NOT NULL,
  -- 'api_key' | 'pat' | 'oauth'
  credential_kind      TEXT NOT NULL CHECK(credential_kind IN ('api_key', 'pat', 'oauth')),
  -- AES-256-GCM ciphertext in the format <iv>:<ct>:<tag>
  -- (lib/security/credentials.ts:encryptCredential). NEVER plaintext.
  encrypted_secret     TEXT NOT NULL,
  -- Optional provider metadata: baseUrl, version, scope (JSON object).
  -- NULL when no extra config is needed.
  config_json          TEXT,
  -- Last successful validate timestamp (epoch-ms). NULL = never validated.
  last_validated_at    INTEGER,
  -- N10: SHA-256 over the canonical JSON of the row without this field itself.
  -- Tamper evidence analogous to the workstream detail-ledger rules.
  content_hash         TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  -- One credential per (scope + provider).
  UNIQUE(scope_kind, scope_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_scope
  ON api_credentials(scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS idx_api_credentials_provider
  ON api_credentials(provider);

-- Append-only audit log (N8)
-- NO FK on api_credentials — remains even after a credential delete.
CREATE TABLE IF NOT EXISTS credential_access_log (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  scope_kind  TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  provider    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  -- 'put' | 'resolve' | 'reveal' | 'delete'
  action      TEXT NOT NULL CHECK(action IN ('put', 'resolve', 'reveal', 'delete')),
  -- Caller context, e.g. 'api:/api/workspaces/[id]/...' or 'vault.resolveApiCredential'
  source      TEXT,
  -- 1 = success, 0 = denied/error
  success     INTEGER NOT NULL CHECK(success IN (0, 1)),
  -- On deny: 'auth-denied' | 'isolation-block' | 'not-found' | 'decrypt-error'
  -- On success: 'workspace-cred' | 'org-fallback'
  reason      TEXT,
  -- N10: SHA-256 of this audit row (for append-only tamper evidence).
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credential_access_log_ts
  ON credential_access_log(ts DESC);

CREATE INDEX IF NOT EXISTS idx_credential_access_log_scope
  ON credential_access_log(scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS idx_credential_access_log_user
  ON credential_access_log(user_id, ts DESC);
