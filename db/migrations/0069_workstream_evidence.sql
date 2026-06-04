-- ============================================================
-- 0069_workstream_evidence.sql — Slice-B M-EVID-02
-- Same-WS Provenance Evidence Table (N2 + N8 + N10).
-- Append-only. ON CONFLICT idempotency via (workstream_id, source_ref, content_hash).
-- Always written in the same TX as the retrieve()/tool_output/user/spawn event.
-- Authority: modules/W2/M-EVID-02/EVIDENCE-TABLE-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2
-- ============================================================
PRAGMA user_version = 62;

CREATE TABLE IF NOT EXISTS workstream_evidence (
  id              TEXT PRIMARY KEY NOT NULL,
  workstream_id   TEXT NOT NULL,
  source_ref      TEXT NOT NULL,
  source_kind     TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  allowed         INTEGER NOT NULL DEFAULT 1,
  bridge_id       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (workstream_id) REFERENCES workstreams(id) ON DELETE RESTRICT,

  CHECK (source_kind IN ('rag_chunk', 'tool_output', 'user', 'spawn')),
  CHECK (allowed = 1),
  CHECK (length(content_hash) = 64),
  CHECK (content_hash GLOB '[0-9a-f]*'),
  CHECK (bridge_id IS NULL OR length(bridge_id) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workstream_evidence_ws_sref_hash
  ON workstream_evidence (workstream_id, source_ref, content_hash);

CREATE INDEX IF NOT EXISTS ix_workstream_evidence_ws_kind
  ON workstream_evidence (workstream_id, source_kind);

CREATE INDEX IF NOT EXISTS ix_workstream_evidence_ws_created
  ON workstream_evidence (workstream_id, created_at);

CREATE INDEX IF NOT EXISTS ix_workstream_evidence_bridge
  ON workstream_evidence (bridge_id)
  WHERE bridge_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_workstream_evidence_append_only
BEFORE UPDATE ON workstream_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-02/N10: workstream_evidence is append-only — UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_workstream_evidence_no_delete
BEFORE DELETE ON workstream_evidence
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-02/N8: workstream_evidence rows are append-only — DELETE forbidden');
END;
