-- 0130_flow_params.sql — Self-Learning Slice 2: Parametrisierung (2026-06-03)
-- Design: docs/plans/2026-06-03_self-learning-workflow-recording-design.md (b) B1/B2.
-- Additiv (ADD COLUMN). NULL = heutiges Verhalten (kein Param, kein Regress).
-- Die getDb-Migrationskette fängt "duplicate column" idempotent ab.

ALTER TABLE flow_templates ADD COLUMN params_json TEXT;  -- JSON-Array von Param-Definitionen
ALTER TABLE flow_steps     ADD COLUMN io_json     TEXT;  -- {inputs:{...}, outputs:[...]} mit {{param.*}}
