-- Migration 0050 — Workflow-Runs (Pattern 4 Foundation, 2026-05-01)
--
-- Addresses Critic-VETO-3 + Anne (Legaly-AI): codified domain workflows
-- as a deterministic FSM. This table persists per run:
--   - workflow_id        : which workflow definition (dev-sprint, ...)
--   - definition_version : v1 | v2 | v3 (side-by-side migration without a mass
--                          migration; old runs keep running on v1, new ones
--                          on v2)
--   - current_state      : current state ID within the definition
--   - data_json          : accumulated data of the previous states
--                          (e.g. planV1, roastTexts, planV2, reviewVerdict)
--   - status             : 'running' | 'stuck' | 'completed' | 'aborted'
--   - last_transition_at : for stuck detection (UI badged "stuck since N min")
--
-- Separation from workstreams:
--   - workstream = multi-agent loop container (Sniper, Swarm, etc.)
--   - workflow_run = methodical step-by-step (deterministic, with
--     pre/post conditions). A workstream CAN drive a workflow run,
--     but does not have to. Workflows can also run headless.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                   TEXT PRIMARY KEY,
  workflow_id          TEXT NOT NULL,
  definition_version   TEXT NOT NULL,
  workspace_id         TEXT,
  workstream_id        TEXT,
  current_state        TEXT NOT NULL,
  data_json            TEXT NOT NULL DEFAULT '{}',
  status               TEXT NOT NULL DEFAULT 'running',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  last_transition_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wfr_workflow ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wfr_workstream ON workflow_runs (workstream_id);
CREATE INDEX IF NOT EXISTS idx_wfr_status ON workflow_runs (status, last_transition_at DESC);
