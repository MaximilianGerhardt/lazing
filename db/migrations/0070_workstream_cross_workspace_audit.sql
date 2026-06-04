-- ============================================================
-- 0070_workstream_cross_workspace_audit.sql — Slice-B M-EVID-03
-- Cross-Workspace-Audit (POS-2, V1.1 §3 + §10 + §19 F2, GDPR Art. 30).
-- Two-table pattern from CROSS-ROAST §C1.
-- Authority: modules/W2/M-EVID-03/CROSS-WS-AUDIT-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0063)
-- bridge_id FK installed post-hoc in 0076a companion.
-- ============================================================

-- Bootstrap base table on fresh DB (idempotent).
CREATE TABLE IF NOT EXISTS workspaces (
  id              TEXT PRIMARY KEY NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS workstream_cross_workspace_audit (
  id                            TEXT    PRIMARY KEY NOT NULL,
  from_workspace_id             TEXT    NOT NULL,
  to_workspace_id               TEXT    NOT NULL,
  query_hash                    TEXT    NOT NULL,
  allowed                       INTEGER NOT NULL,
  denial_code                   TEXT,
  bridge_id                     TEXT,
  dsgvo_art30_metadata_jsonb    TEXT    NOT NULL,
  created_at                    INTEGER NOT NULL DEFAULT (unixepoch()),

  CHECK (from_workspace_id <> to_workspace_id),

  CHECK (
    (allowed = 1 AND denial_code IS NULL)
    OR
    (allowed = 0 AND denial_code IN (
      'no_bridge',
      'bridge_expired',
      'scope_mismatch',
      'policy_deny'
    ))
  ),

  CHECK (
    (allowed = 1 AND bridge_id IS NOT NULL)
    OR
    (allowed = 0)
  ),

  FOREIGN KEY (from_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (to_workspace_id)   REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ix_workstream_cross_ws_audit_from
  ON workstream_cross_workspace_audit (from_workspace_id, created_at);
CREATE INDEX IF NOT EXISTS ix_workstream_cross_ws_audit_to
  ON workstream_cross_workspace_audit (to_workspace_id, created_at);
CREATE INDEX IF NOT EXISTS ix_workstream_cross_ws_audit_bridge
  ON workstream_cross_workspace_audit (bridge_id, created_at)
  WHERE bridge_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_workstream_cross_ws_audit_created
  ON workstream_cross_workspace_audit (created_at);
CREATE INDEX IF NOT EXISTS ix_workstream_cross_ws_audit_denial
  ON workstream_cross_workspace_audit (denial_code, created_at)
  WHERE denial_code IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_workstream_cross_ws_audit_no_update
BEFORE UPDATE ON workstream_cross_workspace_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-03/N2+GDPR: workstream_cross_workspace_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_workstream_cross_ws_audit_no_delete
BEFORE DELETE ON workstream_cross_workspace_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-03/N2+GDPR: workstream_cross_workspace_audit is append-only (no DELETE)');
END;

-- BLOCKER-3 fix (Bug-Fix-1): Cross-table BEFORE-INSERT-Trigger auf workstream_evidence.
-- Blockt jeden direkten raw INSERT mit bridge_id der in denied-Audit-Row protokolliert ist.
CREATE TRIGGER IF NOT EXISTS trg_evidence_cross_ws_denied_block
BEFORE INSERT ON workstream_evidence
FOR EACH ROW
WHEN NEW.bridge_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM workstream_cross_workspace_audit
  WHERE bridge_id = NEW.bridge_id AND allowed = 0
)
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-03/B-R2: evidence-insert blocked: cross-ws bridge denied');
END;
