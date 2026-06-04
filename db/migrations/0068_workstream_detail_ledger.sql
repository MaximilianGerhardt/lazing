-- ============================================================
-- 0068_workstream_detail_ledger.sql — Slice-B M-EVID-01
-- Append-only Body-Store. ON CONFLICT idempotency via (workstream_id, content_hash).
-- Authority: modules/W2/M-EVID-01/DETAIL-LEDGER-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0061 per
--            W2/MIGRATION-RENUMBER.md §2)
-- N1 + N10.
-- ============================================================

-- Bootstrap base table on fresh DB (idempotent; pre-existing schemas ignored).
CREATE TABLE IF NOT EXISTS workstreams (
  id              TEXT PRIMARY KEY NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS workstream_detail_ledger (
  id              TEXT PRIMARY KEY NOT NULL,
  workstream_id   TEXT NOT NULL,
  payload_jsonb   TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  superseded_at   INTEGER,
  superseded_by   TEXT,

  FOREIGN KEY (workstream_id)  REFERENCES workstreams(id)             ON DELETE RESTRICT,
  FOREIGN KEY (superseded_by)  REFERENCES workstream_detail_ledger(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workstream_detail_ledger_ws_hash
  ON workstream_detail_ledger (workstream_id, content_hash);

CREATE INDEX IF NOT EXISTS ix_workstream_detail_ledger_current
  ON workstream_detail_ledger (workstream_id, superseded_at);

CREATE INDEX IF NOT EXISTS ix_workstream_detail_ledger_created
  ON workstream_detail_ledger (workstream_id, created_at);

-- N10 append-only enforcement at DB layer (BUG-FIX-1 CRITIC MUST-FIX-4).
-- UPDATE on superseded_at / superseded_by remains allowed (state-machine).
CREATE TRIGGER IF NOT EXISTS trg_workstream_detail_ledger_payload_immutable
BEFORE UPDATE OF payload_jsonb, content_hash ON workstream_detail_ledger
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-01/N10: payload_jsonb and content_hash are append-only');
END;
