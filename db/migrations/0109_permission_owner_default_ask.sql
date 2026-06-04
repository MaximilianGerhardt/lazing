-- ============================================================
-- 0109_permission_owner_default_ask.sql
--
-- Datum:  2026-05-25
-- Autor:  Security-Critic CRITICAL #1 follow-up (fail-open fix)
-- ADR:    docs/adr/0004-default-permission-mode.md
--
-- Zweck:
--   Migration 0098 seedete den `owner-default`-Row mit
--   mode='freerein-with-audit'. Zusammen mit dem (jetzt entfernten)
--   owner-default-Fallback in readWorkspacePermissionMode führte das dazu,
--   dass JEDER Workspace ohne expliziten Modus zu FreeRein (Write+Bash)
--   auflöste — ein Fail-Open.
--
--   Der eigentliche Fix sitzt im Code (readWorkspacePermissionMode liest
--   NUR noch workspace-spezifische Rows, KEIN owner-default-Fallback mehr).
--   Diese Migration ist Defense-in-Depth: sie setzt einen bereits geseedeten
--   owner-default-Row auf 'ask' (das am wenigsten gewährende Modus), falls er
--   je doch gelesen wird.
--
-- Idempotent:
--   UPDATE ist per Definition wiederholbar; das WHERE schützt davor, einen
--   bereits vom User auf etwas anderes gesetzten owner-default zu überschreiben
--   (wir flippen NUR den 0098-Bootstrap-Wert 'freerein-with-audit').
--
-- N10: content_hash wird auf den Bootstrap-Sentinel für 'ask' gesetzt
--      (analog 0098). Die App rechnet beim nächsten Mutate den echten Hash.
-- ============================================================

UPDATE lazyos_permission_modes
   SET mode         = 'ask',
       reason       = 'ADR-0004 bootstrap downgraded to ask (Security-Critic CRITICAL #1 fail-open fix)',
       content_hash = 'bootstrap:0109:owner-default:ask'
 WHERE workspace_id = 'owner-default'
   AND mode         = 'freerein-with-audit'
   AND set_by       = 'system:0098-migration';
