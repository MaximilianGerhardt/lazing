-- 0127_session_rotation.sql
-- Autonomes Session-Management: Bookkeeping für den degrade→handoff→rotate-Loop.
--
-- Problem (Audit 2026-06-03): EINE ewig wachsende Claude-Session PRO Workspace,
-- per --resume über Wochen weitergeführt (Live: turn 24 / 261 h). Auto-Reset NUR
-- bei last_result='error' (das FALSCHE Signal). Output degradiert mit der Länge.
--
-- Lösung: ein Degradations-/Task-Boundary-Detektor entscheidet, wann rotiert
-- wird; vor der Rotation wird ein Handoff persistiert (fail-closed), die frische
-- Session re-injiziert ihn via buildLazyosSystemPrompt → Kontinuität ohne Bloat.
--
-- Diese Spalten sind ADDITIV (ALTER ADD COLUMN); der Migrations-Runner toleriert
-- "duplicate column name" idempotent (s. 0124). Bestehende Zeilen erhalten die
-- Defaults → unverändertes Verhalten, bis der Detektor greift.

ALTER TABLE claude_sessions ADD COLUMN token_estimate INTEGER NOT NULL DEFAULT 0; -- kumulativer Prompt+Output-Token-Proxy (chars/4)
ALTER TABLE claude_sessions ADD COLUMN task_key       TEXT;                        -- Plan/Task, dem diese Session dient (NULL = workspace-allgemein)
ALTER TABLE claude_sessions ADD COLUMN rotation_count INTEGER NOT NULL DEFAULT 0;  -- wie oft schon rotiert
ALTER TABLE claude_sessions ADD COLUMN rotated_at     INTEGER;                      -- ms der letzten Rotation
ALTER TABLE claude_sessions ADD COLUMN prev_session_id TEXT;                        -- UUID, von der zuletzt wegrotiert wurde (Provenance)
ALTER TABLE claude_sessions ADD COLUMN rotation_reason TEXT;                        -- 'turn-budget'|'token-budget'|'age-budget'|'task-boundary'
