-- ============================================================
-- 0092_workspace_github_repos.sql — GitHub-Integration Backport (Agent 3/8)
--
-- Backport from Lazing-V2 (`packages/runtime/src/store/migrations/012-
-- github-substrate.ts`) onto the lazyos-stable Drizzle/SQLite schema.
--
-- Two tasks:
--   1. `github_credentials` — user-scoped GitHub auth (PAT primary,
--      OAuth secondary). One user → at most one connection. Token
--      AES-256-GCM-encrypted (re-use `encryptCredential` from
--      lib/security/credentials.ts with the same `LAZYOS_CREDENTIAL_KEY`).
--   2. `workspace_github_repos` — N:1 repo→workspace mapping. One
--      workspace can bind multiple repos (backend + frontend in one
--      project). But a repo is assigned to exactly one workspace
--      (UNIQUE on repo_full_name per user).
--
-- Deliberate deviations from the Lazing-V2 schema:
--   - We SPLIT `github_repo TEXT NULL` (in-row column) from the
--     Lazing schema into a dedicated `workspace_github_repos` table,
--     because laz.ing workspaces often have 2 repos (CRM + Web for
--     Demo PV e.g.).
--   - No `github_audit` mirror — laz.ing already has `audit_log`
--     (migration 0026). GitHub audit rows land there with resource
--     'github_repo' / 'github_pr' / 'github_issue'.
--   - Idempotent via IF NOT EXISTS (laz.ing convention, see
--     MIGRATION-NOTES.md "idempotency pattern").
-- ============================================================

CREATE TABLE IF NOT EXISTS github_credentials (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  -- 'pat' (Personal Access Token, default) | 'oauth' (App-flow).
  auth_kind            TEXT NOT NULL DEFAULT 'pat',
  -- AES-256-GCM ciphertext im Format <iv>:<ct>:<tag> (siehe
  -- lib/security/credentials.ts). Niemals plaintext speichern.
  encrypted_token      TEXT NOT NULL,
  -- GitHub-Login (`octocat`). Aus /user-API beim Connect populiert.
  github_login         TEXT,
  -- GitHub-User-ID (numerisch, stable across renames).
  github_user_id       INTEGER,
  -- Avatar-URL fuer UI-Anzeige; optional, refresh on connect.
  avatar_url           TEXT,
  -- OAuth-only: refresh-token (encrypted), scope, expiry. PAT laesst leer.
  encrypted_refresh    TEXT,
  scope                TEXT,
  expires_at           INTEGER,
  -- Audit + UX: when the token was last successfully validated against the
  -- API (connect, reveal, refresh).
  last_validated_at    INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_github_credentials_user
  ON github_credentials(user_id);

CREATE TABLE IF NOT EXISTS workspace_github_repos (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id              TEXT NOT NULL,
  -- `owner/repo` lowercase. Soft-FK against the GitHub API; no cross-table
  -- ref because GitHub is the source of truth.
  repo_full_name       TEXT NOT NULL,
  repo_url             TEXT NOT NULL,
  default_branch       TEXT NOT NULL DEFAULT 'main',
  -- repo.private from the GitHub API. Important for scope enforcement
  -- (private repos must not be mapped into low-sensitivity workspaces
  -- — see lib/github/scope-check.ts, if implemented).
  is_private           INTEGER NOT NULL DEFAULT 0,
  -- Optional: description of the repo (UI hint).
  description          TEXT,
  -- Last successful repo-listings refresh (when the user clicks "Sync").
  -- Pure UX field, not a cache key.
  last_sync_at         INTEGER,
  -- Deliberate consistency with Lazing-V2 — coord identity (N9):
  -- workspace_id suffices as a coord surrogate in the laz.ing setup. We
  -- do not duplicate a ManifestCoord, because N9 is Lazing-specific
  -- (see lib/manifestation/coord.ts there).
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE(user_id, repo_full_name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_github_repos_workspace
  ON workspace_github_repos(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_github_repos_user
  ON workspace_github_repos(user_id);
CREATE INDEX IF NOT EXISTS idx_workspace_github_repos_repo
  ON workspace_github_repos(repo_full_name);
