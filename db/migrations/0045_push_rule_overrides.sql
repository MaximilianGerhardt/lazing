-- Pattern 6a push telemetry (2026-05-01)
-- ------------------------------------------------------------------
-- Collects telemetry on push_rule behavior for a 7d lead time:
--   - notification_dismissed_without_action
--   - notification_clicked
-- Stores an active override state per rule ID that phase 6b
-- (decay.ts, comes after the 7d lead time) derives from the telemetry.
--
-- Fields:
--   rule_id        push-rule ID (lib/push/rules.ts)
--   level          current effective level ('p1' | 'p2' | 'p3' | 'silent')
--   locked         1 = manually pinned (the decay algorithm skips)
--   reason         reason for the override (e.g. 'high-dismiss-rate', 'manual')
--   prev_level     last pre-decay level (for restore)
--   decayed_at     ms timestamp of the last decay action
--   decayed_until  optional ms timestamp when the decay automatically ends
--                  (NULL = until manually restored / next re-evaluation)
CREATE TABLE IF NOT EXISTS push_rule_overrides (
  rule_id     TEXT PRIMARY KEY,
  level       TEXT NOT NULL,
  locked      INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  prev_level  TEXT,
  decayed_at  INTEGER NOT NULL,
  decayed_until INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pro_decayed ON push_rule_overrides(decayed_at DESC);
