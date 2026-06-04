-- 0014: workspace credentials (user feedback 2026-04-25)
--
-- Single-user PWA for Max. One list of key-value pairs per workspace
-- (e.g. STRIPE_KEY, SUPABASE_URL). Encrypted with AES-256-GCM on the
-- server side, key via env LAZYOS_CREDENTIAL_KEY.
--
-- Storage format for encrypted_value: "<iv-hex>:<ciphertext-hex>:<tag-hex>".
-- The caller decrypts only on-demand; listings see only a masked preview.

CREATE TABLE IF NOT EXISTS workspace_credentials (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  description     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_revealed_at INTEGER,
  UNIQUE(workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_credentials_workspace ON workspace_credentials(workspace_id);
