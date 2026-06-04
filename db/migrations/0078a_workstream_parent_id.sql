-- ============================================================
-- 0078a_workstream_parent_id.sql — Slice-B Companion (E2E Wave-0 retroactive)
-- ALTER workstreams ADD COLUMN parent_workstream_id (additive nullable).
-- Authority: MIGRATION-NUMBERING-LEDGER.md §3.3
--
-- E2E walker requires `parent_workstream_id` semantics on `workstreams` for
-- spawn-tree navigation (M-RUN-SPAWN). Lands as Slice-B-companion (NOT a
-- fresh Slice-D claim) because it backfills a Wave-0 invariant on an existing
-- Slice-A table. Per POS-3 additive-nullable rule, column stays NULLABLE.
-- ============================================================

-- Ensure workstreams base table exists (bootstrap-friendly).
CREATE TABLE IF NOT EXISTS workstreams (
  id              TEXT PRIMARY KEY NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Additive column. SQLite ALTER TABLE ADD COLUMN does NOT support inline
-- REFERENCES clause; the FK semantic is enforced via the
-- trg_workstreams_parent_fk_emulate BEFORE-INSERT trigger below.
-- Guarded by user_version gate in runner (re-apply = no-op).
ALTER TABLE workstreams ADD COLUMN parent_workstream_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workstreams_parent
  ON workstreams(parent_workstream_id);

-- FK emulation: parent_workstream_id must reference an existing workstreams.id
-- when non-NULL (mirrors 0076a companion-pattern).
CREATE TRIGGER IF NOT EXISTS trg_workstreams_parent_fk_emulate
BEFORE INSERT ON workstreams
FOR EACH ROW
WHEN NEW.parent_workstream_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM workstreams WHERE id = NEW.parent_workstream_id)
BEGIN
  SELECT RAISE(ABORT,
    '0078a/E2E: parent_workstream_id must reference an existing workstreams.id row');
END;
