-- ============================================================
-- 0071_workstream_decisions.sql — Slice-B M-EVID-04
-- Decisions-Table (N8 Hard-Enforcement). Append-only.
-- Each row carries ≥1 evidence_ref to workstream_evidence.id.
-- Authority: modules/W2/M-EVID-04/DECISIONS-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0064)
-- BUG-FIX-2: 12 decision_kind values + recovered_at marker.
-- ============================================================
CREATE TABLE IF NOT EXISTS workstream_decisions (
  id              TEXT PRIMARY KEY NOT NULL,
  workstream_id   TEXT NOT NULL,
  decision_kind   TEXT NOT NULL
                  CHECK (decision_kind IN (
                    'route','pause','inject','bridge','override',
                    'rag_retrieval_fail_closed',
                    'rag_retrieval_cross_ws_denied',
                    'rag_retrieval_misuse',
                    'rag_retrieval_denial_write_fail',
                    'orphan_detected',
                    'fail_closed_recovery',
                    'pos7_relaxation_override'
                  )),
  rationale       TEXT NOT NULL,
  evidence_refs   TEXT NOT NULL
                  CHECK (
                    json_valid(evidence_refs)
                    AND json_type(evidence_refs) = 'array'
                    AND json_array_length(evidence_refs) >= 1
                  ),
  content_hash    TEXT NOT NULL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  actor           TEXT NOT NULL
                  CHECK (actor IN ('user','agent','policy')),
  recovered_at    INTEGER,

  FOREIGN KEY (workstream_id) REFERENCES workstreams(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workstream_decisions_ws_hash
  ON workstream_decisions (workstream_id, content_hash);

CREATE INDEX IF NOT EXISTS ix_workstream_decisions_ws_created
  ON workstream_decisions (workstream_id, created_at);

CREATE INDEX IF NOT EXISTS ix_workstream_decisions_kind
  ON workstream_decisions (decision_kind, created_at);

CREATE TRIGGER IF NOT EXISTS trg_workstream_decisions_append_only
BEFORE UPDATE ON workstream_decisions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-04/N8: workstream_decisions is append-only — UPDATE forbidden');
END;

CREATE TRIGGER IF NOT EXISTS trg_workstream_decisions_no_delete
BEFORE DELETE ON workstream_decisions
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-04/N8: workstream_decisions is append-only — DELETE forbidden');
END;
