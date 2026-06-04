-- ============================================================
-- 0072_workstream_pauses.sql — Slice-B M-EVID-06
-- STATE table (NOT audit). Transitions inline in transitions_jsonb.
-- Authority: modules/W2/M-EVID-06/PAUSES-FSM-DDL.md §1.1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0065 post BUG-FIX-2 swap)
-- V1.1 §10. Max 1 live pause per workstream (partial UNIQUE index).
-- ============================================================
CREATE TABLE IF NOT EXISTS workstream_pauses (
  id TEXT PRIMARY KEY NOT NULL,
  workstream_id TEXT NOT NULL,

  state TEXT NOT NULL
    CHECK (state IN ('requested','active','resumed','expired','cancelled')),

  expires_at INTEGER,
  reason TEXT,
  requested_by TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  transitions_jsonb TEXT NOT NULL DEFAULT '[]',

  FOREIGN KEY (workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workstream_pauses_workstream_id
  ON workstream_pauses (workstream_id);

CREATE INDEX IF NOT EXISTS idx_workstream_pauses_state_expires
  ON workstream_pauses (state, expires_at)
  WHERE state IN ('requested', 'active');

CREATE INDEX IF NOT EXISTS idx_workstream_pauses_workstream_state
  ON workstream_pauses (workstream_id, state);

-- Live-state uniqueness: max ONE non-terminal pause per workstream.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workstream_pauses_one_live
  ON workstream_pauses (workstream_id)
  WHERE state IN ('requested', 'active');
