-- Phase Sub-WS · Sub-Workstreams (Sprint C, 2026-04-29).
--
-- Sub-workstreams as a first-class entity. Each tier-spawn / auto-dispatch
-- stage / iterate-lead/roaster is represented by its *own* workstream entry
-- that hangs on its master via `parent_workstream_id`.
--
-- This gives:
--   - Tree view of all running sub-agents per master is derivable from the DB.
--   - Token + cost are recorded per sub (live indicator + top consumer).
--   - The tmux session ID is stored too -> click on a sub jumps into the session.
--
-- Backwards-compat: existing master workstreams have
-- `parent_workstream_id IS NULL` and are still delivered as master.
-- `role`, `tokens_in`, `tokens_out`, `cost_cents_aggregated`, `tmux_session_id`
-- are all nullable / default 0.
--
-- Idempotency: on `duplicate column name` the migration runner falls back to
-- per-statement mode and skips the colliding column
-- (see the db/client.ts strategy block). The index is via `IF NOT EXISTS`.
--
-- P1-1 fix (2026-04-29): NO BEGIN/COMMIT wrapper here. Reason:
-- the migration runner in db/client.ts splits on an exec() error
-- via the regex `;\s*$/m` and runs each statement individually. A
-- `BEGIN;` as its own statement would fail on re-run, because
-- after the per-statement loop no transaction state is consistent anymore
-- (BEGIN hangs, ALTERs fail as duplicate, COMMIT fails without an
-- open tx). A non-atomic apply is acceptable: SQLite serializes
-- ALTER TABLE individually, and re-runs are idempotent via the duplicate-column
-- catch. Risk: on a crash between ALTERs the schema stays
-- partial. Manually fixable, because every ADD COLUMN is idempotent.

ALTER TABLE workstreams ADD COLUMN parent_workstream_id TEXT REFERENCES workstreams(id) ON DELETE CASCADE;
ALTER TABLE workstreams ADD COLUMN role TEXT;
ALTER TABLE workstreams ADD COLUMN tmux_session_id TEXT;
ALTER TABLE workstreams ADD COLUMN tokens_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workstreams ADD COLUMN tokens_out INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workstreams ADD COLUMN cost_cents_aggregated INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_workstreams_parent
  ON workstreams(parent_workstream_id);
