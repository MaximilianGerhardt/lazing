-- Migration 0052 — workspace-isolated RAG (GDPR/DPA tenant separation).
--
-- Date: 2026-04-30
-- Plan:  docs/plans/2026-04-30_workspace-rag-isolation.md
-- Driver: Art. 28 GDPR (data processor — tenant separation) +
--          § 9 BDSG (technical-organizational measures).
--
-- Status quo before this migration:
--   * rag_chunks (from migration 0042) has workspace_id NOT NULL — good.
--   * BUT: no FK constraint, no read view, no trigger.
--           A forgotten WHERE clause in the caller (lib/rag/retriever.ts or
--           a new MCP wrapper) would allow cross-tenant leaks.
--
-- What this migration delivers (additive, purely defense-in-depth):
--   1. Triggers BEFORE INSERT/UPDATE on rag_chunks that check workspace_id against
--      workspaces(id) — sqlite-FK equivalent without a table copy.
--   2. View v_rag_chunks_workspace as the future single official
--      read path (service-layer refactor follows in the next spawn).
--   3. Audit table rag_cross_workspace_audit for logged owner searches
--      across multiple tenants (GDPR Art. 30 RoPA requirement).
--   4. Helper table rag_migration_audit_0052 that snapshots orphans (workspace_id
--      that no longer exists in workspaces) — for triage
--      by the service-refactor spawn. A live probe from 2026-04-30 shows
--      0 orphans, so probably empty.
--
-- Idempotency:
--   * All CREATE statements via IF NOT EXISTS.
--   * Trigger names are unique (rag_chunks_workspace_fk_*).
--   * Re-run rewrites rag_migration_audit_0052 with the current state if needed
--     (INSERT OR REPLACE on primary key workspace_id).
--
-- Rollback (if needed — manual, not part of this file):
--   DROP TRIGGER rag_chunks_workspace_fk_insert;
--   DROP TRIGGER rag_chunks_workspace_fk_update;
--   DROP VIEW   v_rag_chunks_workspace;
--   DROP TABLE  rag_cross_workspace_audit;
--   DROP TABLE  rag_migration_audit_0052;
--
-- NO BEGIN/COMMIT wrapper (see the 0040 P1-1 fix note in MIGRATION-NOTES.md).

----------------------------------------------------------------------------
-- 1. Audit snapshot for existing orphans (diagnosis, non-blocking)
----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rag_migration_audit_0052 (
  workspace_id    TEXT PRIMARY KEY,
  chunk_count     INTEGER NOT NULL,
  detected_at     INTEGER NOT NULL
);

-- Orphan detection: rag_chunks rows whose workspace_id does not exist in
-- workspaces. INSERT OR REPLACE so re-run is idempotent.
INSERT OR REPLACE INTO rag_migration_audit_0052 (workspace_id, chunk_count, detected_at)
SELECT
  rc.workspace_id,
  COUNT(*) AS chunk_count,
  CAST(strftime('%s','now') AS INTEGER) * 1000 AS detected_at
FROM rag_chunks rc
LEFT JOIN workspaces w ON w.id = rc.workspace_id
WHERE w.id IS NULL
GROUP BY rc.workspace_id;

----------------------------------------------------------------------------
-- 2. FK equivalent via trigger (sqlite has no ALTER TABLE ADD CONSTRAINT)
----------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS rag_chunks_workspace_fk_insert
BEFORE INSERT ON rag_chunks
FOR EACH ROW
WHEN NEW.workspace_id IS NULL
   OR NEW.workspace_id = ''
   OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'rag_chunks.workspace_id must reference workspaces.id (DSGVO mandant-trennung)');
END;

CREATE TRIGGER IF NOT EXISTS rag_chunks_workspace_fk_update
BEFORE UPDATE OF workspace_id ON rag_chunks
FOR EACH ROW
WHEN NEW.workspace_id IS NULL
   OR NEW.workspace_id = ''
   OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.workspace_id)
BEGIN
  SELECT RAISE(ABORT, 'rag_chunks.workspace_id must reference workspaces.id (DSGVO mandant-trennung)');
END;

----------------------------------------------------------------------------
-- 3. Read-only view — the ONLY official read path from the service refactor on.
----------------------------------------------------------------------------

-- Defense-in-depth properties:
--   * INNER JOIN on workspaces — orphan chunks (should there be any) are
--     invisible until they are cleaned up.
--   * sensitivity != 'high' — the privacy-gate rule is hard-wired in the view,
--     not only in the retriever.
--   * The service layer MUST additionally append WHERE workspace_id = ? —
--     the view is belt-and-suspenders, not the filter itself.
--
-- Note for the service-refactor spawn:
--   Drizzle: map it in db/schema/rag.ts with sqliteView(), NOT with
--   sqliteTable. Otherwise Drizzle tries to re-create the view on migrate
--   rebuilds and stumbles over the CREATE VIEW IF NOT EXISTS.

CREATE VIEW IF NOT EXISTS v_rag_chunks_workspace AS
SELECT
  rc.id,
  rc.workspace_id,
  rc.source_type,
  rc.source_id,
  rc.source_version,
  rc.chunk_index,
  rc.text,
  rc.embedding,
  rc.token_count,
  rc.sensitivity,
  rc.indexed_at,
  rc.expires_at
FROM rag_chunks rc
INNER JOIN workspaces w ON w.id = rc.workspace_id
WHERE rc.sensitivity != 'high';

----------------------------------------------------------------------------
-- 4. Cross-workspace audit table (GDPR Art. 30 RoPA)
----------------------------------------------------------------------------

-- Every retrieveAcrossWorkspaces() call writes an entry here.
-- Required fields for a later DPA/DPO disclosure:
--   * user_id          — who queried
--   * query            — what was searched for (shortening sensible, not here)
--   * workspaces_seen  — JSON array ['A','B','C'] of the workspaces in the result
--   * hits             — number of chunks in the result
--   * reason           — free-text/tag why cross-workspace (e.g.
--                        'owner-search', 'pattern-discovery', 'compliance-audit')

CREATE TABLE IF NOT EXISTS rag_cross_workspace_audit (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  query           TEXT NOT NULL,
  workspaces_seen TEXT NOT NULL,
  hits            INTEGER NOT NULL,
  reason          TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_xws_user
  ON rag_cross_workspace_audit (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_xws_recent
  ON rag_cross_workspace_audit (created_at DESC);
