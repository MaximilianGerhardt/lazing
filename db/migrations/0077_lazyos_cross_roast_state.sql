-- ============================================================
-- 0077_lazyos_cross_roast_state.sql — Slice-B M-POL-03 (NEW in BUG-FIX-1)
-- Cross-Roast Defend-or-Remove-Round-State (BLOCKER-4 mitigation).
-- Same-TX-Lock via BEGIN IMMEDIATE; append-only history via trigger.
-- Authority: modules/W2/M-POL-03/CROSS-ROAST-TRIGGER-SPEC.md Appendix §A
--            MIGRATION-NUMBERING-LEDGER.md §3.2
-- ============================================================

-- Round-state (mutable, primary-key durch (module, diff_content_hash))
CREATE TABLE IF NOT EXISTS lazyos_cross_roast_state (
  module                         TEXT    NOT NULL,
  diff_content_hash              TEXT    NOT NULL,
  round                          INTEGER NOT NULL CHECK (round BETWEEN 1 AND 3),

  previous_blocker_count         INTEGER NOT NULL DEFAULT 0,
  current_blocker_count          INTEGER NOT NULL DEFAULT 0,
  previous_finding_hashes_json   TEXT    NOT NULL DEFAULT '[]',
  current_finding_hashes_json    TEXT    NOT NULL DEFAULT '[]',
  trend                          TEXT    NOT NULL CHECK (trend IN ('reduced-proper','equality','drift','mixed','initial')),

  status                         TEXT    NOT NULL CHECK (status IN (
                                          'in-progress','accepted','rejected',
                                          'implementer-withdrawn','convergence-failed',
                                          'queued','cancelled-by-implementer')),
  next_state                     TEXT,
  defense_verification_log       TEXT,

  updated_at                     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by_worktree            TEXT    NOT NULL,

  PRIMARY KEY (module, diff_content_hash)
);

-- History (append-only audit trail of every INSERT/UPDATE).
CREATE TABLE IF NOT EXISTS lazyos_cross_roast_state_history (
  history_id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  module                         TEXT    NOT NULL,
  diff_content_hash              TEXT    NOT NULL,
  round                          INTEGER NOT NULL,
  previous_blocker_count         INTEGER NOT NULL,
  current_blocker_count          INTEGER NOT NULL,
  previous_finding_hashes_json   TEXT    NOT NULL,
  current_finding_hashes_json    TEXT    NOT NULL,
  trend                          TEXT    NOT NULL,
  status                         TEXT    NOT NULL,
  next_state                     TEXT,
  defense_verification_log       TEXT,
  recorded_at                    TEXT    NOT NULL DEFAULT (datetime('now')),
  recorded_by_worktree           TEXT    NOT NULL,
  operation                      TEXT    NOT NULL CHECK (operation IN ('INSERT','UPDATE','DELETE'))
);

CREATE INDEX IF NOT EXISTS idx_cross_roast_state_module       ON lazyos_cross_roast_state(module);
CREATE INDEX IF NOT EXISTS idx_cross_roast_state_status       ON lazyos_cross_roast_state(status);
CREATE INDEX IF NOT EXISTS idx_cross_roast_state_history_mod  ON lazyos_cross_roast_state_history(module, recorded_at);

CREATE TRIGGER IF NOT EXISTS trg_cross_roast_state_history_insert
AFTER INSERT ON lazyos_cross_roast_state
BEGIN
  INSERT INTO lazyos_cross_roast_state_history (
    module, diff_content_hash, round,
    previous_blocker_count, current_blocker_count,
    previous_finding_hashes_json, current_finding_hashes_json,
    trend, status, next_state, defense_verification_log,
    recorded_by_worktree, operation
  ) VALUES (
    NEW.module, NEW.diff_content_hash, NEW.round,
    NEW.previous_blocker_count, NEW.current_blocker_count,
    NEW.previous_finding_hashes_json, NEW.current_finding_hashes_json,
    NEW.trend, NEW.status, NEW.next_state, NEW.defense_verification_log,
    NEW.updated_by_worktree, 'INSERT'
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_cross_roast_state_history_update
AFTER UPDATE ON lazyos_cross_roast_state
BEGIN
  INSERT INTO lazyos_cross_roast_state_history (
    module, diff_content_hash, round,
    previous_blocker_count, current_blocker_count,
    previous_finding_hashes_json, current_finding_hashes_json,
    trend, status, next_state, defense_verification_log,
    recorded_by_worktree, operation
  ) VALUES (
    NEW.module, NEW.diff_content_hash, NEW.round,
    NEW.previous_blocker_count, NEW.current_blocker_count,
    NEW.previous_finding_hashes_json, NEW.current_finding_hashes_json,
    NEW.trend, NEW.status, NEW.next_state, NEW.defense_verification_log,
    NEW.updated_by_worktree, 'UPDATE'
  );
END;
