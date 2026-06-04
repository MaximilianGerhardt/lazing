-- 0116_flow_runs_repro_persistence.sql · 2026-05-29
--
-- ARCHITEKTUR-WAHRHEIT (verifiziert am Code):
--   db/migrations/0112_flow_studio.sql:57-65 — flow_runs(id, flow_id,
--     workspace_id, workstream_id, status, created_at, updated_at).
--   lib/flow/templates-repo.ts:256 createFlowRun() — schreibt heute NUR im
--     dispatch-Pfad (running). needs-coupling/needs-style-choice/Compose-
--     Fehler → KEIN flow_run-Row → Owner sieht im "kurzen Check kein neuer
--     flow_run und kein neuer workstream" (Master-Kontext §10 Befund 2).
--   lib/flow/compose-and-run.ts — branched ohne jemals einen Pending-Run zu
--     persistieren.
--
-- PROBLEM (Master-Kontext §10 Befund 2, verbatim vom Owner):
--   "UI erzeugte System · auto-flow-detected. Network zeigte genau ein POST
--    /api/flow/compose-and-run. Kein POST /api/chat/stream. Payload ging an
--    workspaceId: 'example-website-2'. Innerhalb des kurzen Waits kam keine klare
--    Flow-Antwort/Surface zurück. Es wurde im kurzen Check kein neuer
--    flow_run und kein neuer workstream sichtbar."
--
-- DIESER FIX (Track-D · 2026-05-29):
--   Additive Spalten auf flow_runs:
--     - req_id        TEXT  — Request-Korrelation (UI ↔ Server-Log ↔ DB).
--     - error_message TEXT  — bei status='failed' die Fehler-Nachricht (N8:
--                             Trace ist Evidence — Owner sieht WARUM ein
--                             Lauf scheiterte, ohne Logs zu durchsuchen).
--     - error_code    TEXT  — der maschinen-lesbare Fehler-Code (z.B.
--                             flow_compose_error/flow_dispatch_error/
--                             compose_and_run_failed) — für UI-Filter.
--
--   Die compose-and-run-Spine wird parallel (lib/flow/persistence.ts) so
--   erweitert, dass SOFORT nach erfolgreichem composeFlowFromIntent ein
--   flow_runs-Row mit status='pending' geschrieben wird — AUCH wenn der
--   Branch needs-coupling oder needs-style-choice ist (der Run ist
--   initiiert, nur blockiert).
--
-- N4 (Substrat-Disziplin):
--   KEINE neue Tabelle, KEIN neuer Status-Enum. Bestehende status-Werte
--   ('pending'|'running'|'done'|'failed'|'cancelled' aus 0112) reichen aus.
--
-- SQLite-Idempotenz:
--   ALTER TABLE ADD COLUMN IF NOT EXISTS gibt es in SQLite NICHT. Der
--   Migrations-Runner (db/client.ts) kapselt jede Migration in einen
--   try/catch (siehe lib/flow/__tests__/compose-and-run.test.ts:freshDb —
--   /duplicate column name/ wird tolerant geschluckt). Wir verlassen uns
--   auf dieses Tolerieren bei Re-Run gegen eine DB, die die Spalten schon
--   hat.
-- ============================================================

ALTER TABLE flow_runs ADD COLUMN req_id        TEXT;
ALTER TABLE flow_runs ADD COLUMN error_message TEXT;
ALTER TABLE flow_runs ADD COLUMN error_code    TEXT;

CREATE INDEX IF NOT EXISTS idx_flow_runs_req_id ON flow_runs(req_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_status_created
  ON flow_runs(status, created_at DESC);
