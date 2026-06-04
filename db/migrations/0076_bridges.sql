-- ============================================================
-- 0076_bridges.sql — Slice-B M-RAG-05
-- Bridges-Table (POS-2, V1.1 §3 expires_at NOT NULL, GDPR Art. 30).
-- Append-only post-approval; revoke via expires_at=now() (de-facto invalidation).
-- Authority: modules/W2/M-RAG-05/BRIDGES-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0073)
-- ============================================================
CREATE TABLE IF NOT EXISTS bridges (
  id                       TEXT    PRIMARY KEY NOT NULL,
  from_coord               TEXT    NOT NULL,
  to_coord                 TEXT    NOT NULL,
  approved_by              TEXT    NOT NULL,
  approved_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at               INTEGER NOT NULL,
  dsgvo_metadata_jsonb     TEXT    NOT NULL,
  created_at               INTEGER NOT NULL DEFAULT (unixepoch()),

  CHECK (expires_at > approved_at),
  CHECK (from_coord <> to_coord),
  CHECK (length(id) = 26),
  CHECK (length(approved_by) >= 1),

  CHECK (
    json_valid(from_coord)
    AND json_extract(from_coord, '$.kind') IN ('personal','org','workspace','project')
  ),
  CHECK (
    json_valid(to_coord)
    AND json_extract(to_coord, '$.kind') IN ('personal','org','workspace','project')
  ),

  CHECK (json_valid(dsgvo_metadata_jsonb))
);

CREATE INDEX IF NOT EXISTS ix_bridges_id_expires
  ON bridges (id, expires_at);

CREATE INDEX IF NOT EXISTS ix_bridges_coord_pair
  ON bridges (from_coord, to_coord, expires_at);

CREATE INDEX IF NOT EXISTS ix_bridges_approved_by
  ON bridges (approved_by, approved_at);

CREATE INDEX IF NOT EXISTS ix_bridges_approved_at
  ON bridges (approved_at);

-- Append-only post-approval: frozen-field-block trigger.
CREATE TRIGGER IF NOT EXISTS trg_bridges_no_field_update
BEFORE UPDATE ON bridges
FOR EACH ROW
WHEN OLD.id                   <> NEW.id
  OR OLD.from_coord           <> NEW.from_coord
  OR OLD.to_coord             <> NEW.to_coord
  OR OLD.approved_by          <> NEW.approved_by
  OR OLD.approved_at          <> NEW.approved_at
  OR OLD.dsgvo_metadata_jsonb <> NEW.dsgvo_metadata_jsonb
  OR OLD.created_at           <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'M-RAG-05/V1.1§3: bridges is append-only post-approval (only expires_at may be reduced via revokeBridge)');
END;

-- expires_at may only be reduced (revocation), never increased.
CREATE TRIGGER IF NOT EXISTS trg_bridges_no_expires_extend
BEFORE UPDATE OF expires_at ON bridges
FOR EACH ROW
WHEN NEW.expires_at > OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'M-RAG-05/V1.1§3: bridges.expires_at may only be reduced (revoke), not extended (use createBridge for renewal)');
END;

-- DELETE is never allowed — not even for expired bridges (the audit trail stays).
CREATE TRIGGER IF NOT EXISTS trg_bridges_no_delete
BEFORE DELETE ON bridges
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-RAG-05/V1.1§3: bridges rows are immortal (audit-trail); expired rows stay for GDPR Art. 30 disclosure');
END;
