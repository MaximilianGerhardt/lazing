-- ============================================================
-- 0076a_add_cross_ws_audit_bridge_fk.sql — Slice-B Companion
-- ALTER cross_workspace_audit ADD FK→bridges.
-- Authority: modules/W2/M-EVID-03/CROSS-WS-AUDIT-DDL.md §5
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (NEW companion for MAJOR-M2)
--
-- SQLite cannot add FK constraints via ALTER TABLE ADD CONSTRAINT. The
-- equivalent semantic ("if bridge_id is non-NULL, it MUST reference an
-- existing bridges.id row") is enforced via a BEFORE-INSERT trigger.
-- Combined with the M-EVID-03 append-only trigger this provides
-- equivalent referential integrity without a destructive rebuild.
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_cross_ws_audit_bridge_fk_emulate
BEFORE INSERT ON workstream_cross_workspace_audit
FOR EACH ROW
WHEN NEW.bridge_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM bridges WHERE id = NEW.bridge_id)
BEGIN
  SELECT RAISE(ABORT,
    'M-EVID-03/MAJOR-M2: bridge_id must reference an existing bridges.id row (companion 0076a FK emulation)');
END;
