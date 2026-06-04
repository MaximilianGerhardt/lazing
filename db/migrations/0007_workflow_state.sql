-- lazyOS Sprint 2 · Stream H — Approval-FSM Workflow-State
--
-- The workflow state (draft/review/approved/executed/closed/rejected) is
-- event-derived. We store NO physical column on a tickets
-- table (there is none — tickets are projections from the event log).
-- Instead:
--
--   1. The FSM logic lives in lib/approvals/fsm.ts (pure functions).
--   2. Transitions are emitted as events
--      (approval_requested / approved / rejected / executed / closed / reopened).
--   3. The projection in lib/events/project.ts folds the last workflow state
--      into TicketProjection.workflowState (string stays, but the allowed
--      values are now the FSM states).
--
-- This migration is pure NO-OP/docs — it exists so the linear
-- migration history stays complete and the state change is
-- traceable in the git diff.
--
-- We additionally create an index on events(entity_type, event_type)
-- that speeds up the FSM replay query:
--   SELECT event_type FROM events
--   WHERE entity_type='ticket' AND entity_id=?
--     AND event_type IN ('approval_requested','approved','rejected',
--                        'executed','closed','reopened','created')
--   ORDER BY created_at DESC LIMIT 1;

CREATE INDEX IF NOT EXISTS idx_events_entity_type_event
  ON events (entity_type, event_type);

-- Dedup cache for the push-trigger engine (Stream H part 2).
-- An in-memory cache would disappear on Lambda cold-start and lead to duplicate
-- pushes. Persistent SQLite table with a TTL column.
CREATE TABLE IF NOT EXISTS push_dedup (
  dedup_key   TEXT PRIMARY KEY,
  rule_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_dedup_expires
  ON push_dedup (expires_at);

-- Per-rule rate-limit counter (persistent, so Lambda restarts
-- do not bypass the daily cap).
CREATE TABLE IF NOT EXISTS push_counters (
  bucket      TEXT PRIMARY KEY,   -- e.g. 'global:day:2026-04-24' or 'rule:errors-burst:min:<epoch>'
  count       INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_push_counters_expires
  ON push_counters (expires_at);

-- Audit log: every triggered or suppressed push is recorded here once,
-- so we can trace in the Observatory WHY a notification
-- did not get through (dedup, cap, rule-miss).
CREATE TABLE IF NOT EXISTS push_audit (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  rule_id     TEXT NOT NULL,
  event_id    TEXT,
  outcome     TEXT NOT NULL,       -- 'sent' | 'dedup' | 'cap' | 'error' | 'skipped'
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_audit_created
  ON push_audit (created_at DESC);
