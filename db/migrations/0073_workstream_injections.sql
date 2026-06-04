-- ============================================================
-- 0073_workstream_injections.sql — Slice-B M-EVID-05
-- Pause-Injection Idempotency-Row (N1 + N8 + N10). Append-only.
-- Idempotency via UNIQUE (workstream_id, pause_id, content_hash).
-- Authority: modules/W2/M-EVID-05/INJECTIONS-DDL.md §1
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0066 post BUG-FIX-2 swap)
-- Migration-Order: runs AFTER 0072_workstream_pauses.sql.
-- ============================================================
CREATE TABLE IF NOT EXISTS workstream_injections (
  id              TEXT PRIMARY KEY NOT NULL,
  workstream_id   TEXT NOT NULL,
  pause_id        TEXT NOT NULL,

  payload         TEXT NOT NULL,

  content_hash    TEXT NOT NULL,

  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),

  FOREIGN KEY (workstream_id) REFERENCES workstreams(id)        ON DELETE RESTRICT,
  FOREIGN KEY (pause_id)      REFERENCES workstream_pauses(id)  ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workstream_injections_ws_pause_hash
  ON workstream_injections (workstream_id, pause_id, content_hash);

CREATE INDEX IF NOT EXISTS ix_workstream_injections_pause
  ON workstream_injections (pause_id, created_at);

CREATE INDEX IF NOT EXISTS ix_workstream_injections_workstream
  ON workstream_injections (workstream_id, created_at);

-- Active-Pause-Guard: injection requires pause.state == 'active'.
CREATE TRIGGER IF NOT EXISTS trg_injections_require_active_pause
BEFORE INSERT ON workstream_injections
FOR EACH ROW
WHEN (SELECT state FROM workstream_pauses WHERE id = NEW.pause_id) != 'active'
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-05/V1.1§10: injection requires active pause');
END;

-- Append-only Enforcement (N1 + N10).
CREATE TRIGGER IF NOT EXISTS trg_workstream_injections_append_only
BEFORE UPDATE ON workstream_injections
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'M-EVID-05/N10: workstream_injections is append-only');
END;
