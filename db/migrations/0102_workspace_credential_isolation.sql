-- ============================================================
-- 0102_workspace_credential_isolation.sql — ACL-3 (D2)
--
-- New column `credential_isolation` on the `workspaces` table.
-- ORTHOGONAL to `sensitivity` — no overlap.
--
-- Axes compared:
--   sensitivity            — GDPR/RAG indexing axis
--                            (low|normal|high, controls whether chunks are
--                             indexed in v_rag_chunks_workspace)
--   credential_isolation   — credential inheritance axis (NEW)
--                            (inherit|isolated, controls whether a workspace
--                             may fall back to org-level credentials)
--
-- Values:
--   'inherit'   — the workspace may use org credentials as a fallback.
--                 Default. Backward-compat for all existing rows.
--   'isolated'  — the workspace has exclusively its own credentials.
--                 No org fallback allowed (external customers, strict separation).
--
-- SQLite: ALTER TABLE … ADD COLUMN with NOT NULL + DEFAULT is
-- idempotency-compatible (IF NOT EXISTS is not supported for ADD COLUMN
-- — we check existence via the migration-runner table).
-- CHECK constraint: SQLite does not allow inline CHECK via ADD COLUMN
-- (only on CREATE TABLE). The constraint is therefore documented rather than
-- enforced — the application layer in route.ts enforces the whitelist.
-- ============================================================

ALTER TABLE workspaces
  ADD COLUMN credential_isolation TEXT NOT NULL DEFAULT 'inherit';

-- Index for the vault resolver: fast lookup whether a workspace is isolated.
CREATE INDEX IF NOT EXISTS idx_workspaces_credential_isolation
  ON workspaces(credential_isolation);
