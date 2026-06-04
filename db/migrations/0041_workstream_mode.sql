-- Phase Tier-Lock · Workstream-Mode + Iterate-Config + Dispatch-Lock (2026-04-30).
--
-- Sub-Plan A (respect the tier choice) + Sub-Plan G (double-spawn lock) from
-- the master plan 2026-04-30. Previously runIterate completely ignored the
-- user's choice in the TierChoice picker (roaster count + sniper loop hard-
-- wired). Now we persist the choice as JSON on the workstream and
-- read it in the orchestrator + auto-dispatch spawner.
--
-- Columns:
--   * mode               TEXT  — mode marker ('iterate' | 'swarm' | NULL).
--                                NULL = legacy workstream without a choice, treated as
--                                'iterate' + standard preset.
--   * iterate_config_json TEXT — JSON-encoded IterateConfig
--                                (presetId, leadCount, roasterCount, sniperLoop,
--                                 stages[], estMinutes). NULL = default
--                                TIER_PRESETS.standard.
--   * dispatch_lock_token TEXT — ulid() per start-dispatch call. A second
--                                parallel call finds the token set AND
--                                lock_ts < 60s old → 409. After
--                                auto_close_after_subs cleared to NULL.
--   * dispatch_lock_ts   INTEGER (ms) — timestamp of lock acquisition. >=60s
--                                old = expired = a new call may acquire.
--
-- Idempotency: on `duplicate column name` the migration runner falls back to
-- per-statement mode (see the db/client.ts strategy block, same
-- mechanism as 0040). Re-run-safe.
--
-- NO BEGIN/COMMIT wrapper (see the 0040 P1-1 fix note).

ALTER TABLE workstreams ADD COLUMN mode TEXT;
ALTER TABLE workstreams ADD COLUMN iterate_config_json TEXT;
ALTER TABLE workstreams ADD COLUMN dispatch_lock_token TEXT;
ALTER TABLE workstreams ADD COLUMN dispatch_lock_ts INTEGER;
