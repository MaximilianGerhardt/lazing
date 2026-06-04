-- Migration 0051 — Workstream-Intent-Classification (2026-05-01).
--
-- Addresses a user finding: "the difference between the implementation of
-- ideas still not clear". Without a visible intent marker, brainstorming cards,
-- bugfix sessions and implementation pipelines blur visually in the
-- workstream list / chat stream. We classify each
-- workstream at spawn and persist the result here.
--
-- Values (canonical):
--   * 'idea'           — brainstorm, what-if, vision
--   * 'implementation' — build, deploy, implement
--   * 'bug-fix'        — error, broken, fix
--   * 'question'       — knowledge-oriented, Q&A
--   * 'discussion'     — default + all other discussions
--
-- Backwards-compat: the column is NULLABLE. Existing workstreams without
-- intent are treated as 'discussion' in the service layer (rowToWorkstream
-- normalizes NULL → 'discussion' on read).
--
-- Idempotency: on `duplicate column name` the migration runner falls back to
-- per-statement mode (see the db/client.ts strategy block).
-- Re-run-safe.
--
-- NO BEGIN/COMMIT wrapper (see the 0040 P1-1 fix note).

ALTER TABLE workstreams ADD COLUMN intent TEXT;
CREATE INDEX IF NOT EXISTS idx_workstreams_intent ON workstreams (intent);
