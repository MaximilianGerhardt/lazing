-- ============================================================
-- 0096_org_github_credentials.sql — Org-Level GitHub-Integration (Slice A)
--
-- New table `org_github_credentials`:
--   - The org owns the connection (1 org → max. 1 GitHub connection).
--   - Token AES-256-GCM-encrypted (same key as github_credentials:
--     LAZYOS_CREDENTIAL_KEY via lib/security/credentials.ts).
--   - ON DELETE CASCADE — deleting the org automatically deletes the connection.
--   - UNIQUE(org_id) — structurally impossible to have two connections per org.
--
-- Isolation guarantee (N9 + design):
--   All queries on this table MUST have `WHERE org_id = ?`.
--   API routes additionally check via assertOrgRole(req, orgId, minRole).
--   Org A cannot structurally read Org B's token (no path without org_id).
--
-- Idempotent via IF NOT EXISTS (laz.ing convention — MIGRATION-NOTES.md).
-- ============================================================

CREATE TABLE IF NOT EXISTS org_github_credentials (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- 'pat' (Personal Access Token, default) | 'oauth' | 'github_app'
  auth_kind            TEXT NOT NULL DEFAULT 'pat',
  -- AES-256-GCM ciphertext in the format <iv>:<ct>:<tag>
  -- (lib/security/credentials.ts:encryptCredential). NEVER plaintext.
  encrypted_token      TEXT NOT NULL,
  -- GitHub login (`octocat`) — populated from the /user API on connect.
  github_login         TEXT,
  -- Stable numeric GitHub user ID (survives renames).
  github_user_id       INTEGER,
  -- Avatar URL for UI display; optional.
  avatar_url           TEXT,
  -- OAuth-only: granted scope string ("repo,read:org"). PAT leaves empty.
  scope                TEXT,
  -- OAuth/App-only: token expiry epoch-ms. PAT typically NULL.
  expires_at           INTEGER,
  -- Last successful /user validate timestamp (UX + audit, N10).
  last_validated_at    INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  -- Only one GitHub connection per org.
  UNIQUE(org_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_github_credentials_org
  ON org_github_credentials(org_id);

CREATE INDEX IF NOT EXISTS idx_org_github_credentials_org
  ON org_github_credentials(org_id);
