-- Migration 0048 — sandbox mode per workspace (P16, 2026-05-01)
--
-- Context:
-- Anne (Legaly-AI): "what is the worst case... what are the boundary conditions,
-- and then within this clearly staked-out playing field, also allow
-- decisions freely and quickly."
--
-- The existing sensitivity (low/medium/high) is static and a workspace class.
-- Sandbox mode is an additional switch for "own experiments, free
-- rein": auto-approve after synthesis, no routine push notifications.
--
-- Security constraint:
-- Sandbox mode is activatable ONLY when workspace.sensitivity = 'low'.
-- That is enforced server-side in the toggle route; at the DB level a
-- simple default-0 value suffices. The loop guard and multi-account isolation
-- stay active in EVERY case (safety requirement per memory).
--
-- Idempotency: ALTER TABLE ADD COLUMN — the duplicate-column fallback in
-- db/client.ts takes effect on the second run.

ALTER TABLE workspaces ADD COLUMN sandbox_mode INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_workspaces_sandbox
  ON workspaces(sandbox_mode)
  WHERE sandbox_mode = 1;
