-- 0115_tickets_legacy_compat.sql · 2026-05-28
--
-- ARCHITEKTUR-WAHRHEIT (verifiziert am Code):
--   db/schema/workstreams.ts:5     — „N Feature-Tickets (über event-sourced
--                                    parent_ticket_id), eine primäre …"
--   db/schema/work_products.ts:10  — „Keine harte FK auf tickets — Tickets
--                                    existieren nur als Projektion"
--   → Tickets sind im laz.ing-Modell event-sourced. Keine physische Tabelle.
--
-- PROBLEM (Owner-Live-Test 2026-05-28):
--   3 Legacy-Routen lesen weiterhin gegen eine physische `tickets`-Tabelle:
--     app/api/workstreams/[id]/cross-roast/route.ts:118,124
--     app/api/workstreams/[id]/inject/route.ts:118
--     app/api/workstreams/[id]/pause-status/route.ts:126
--   Beim UI-Polling (Sub-Workstream-Card holt pause-status) → 19 wiederholte
--   `SqliteError: no such table: tickets` im prod-Log → Route antwortet 500 →
--   UI fällt auf 'failed'-Default zurück, obwohl alle 4 iterate-Sub-Workstreams
--   in der workstreams-Tabelle korrekt 'paused' sind.
--
-- DIESER FIX (Pflaster, additiv, N4):
--   CREATE TABLE IF NOT EXISTS tickets — exakt die Spalten, die die 3 Routes
--   selecten (id, title, body, parent_ticket_id, workflow_state) + standard ts.
--   Tabelle bleibt LEER. Routen liefern dann valide leere Resultate statt 500.
--   Polling-Loop wird sauber, UI zeigt den realen workstreams.status statt
--   'failed'-Fallback.
--
-- ECHTER FIX (dokumentierter Folge-Slice, NICHT hier):
--   Die 3 Routes auf event-sourced-Projection umstellen (events → Ticket-Shape).
--   Bedeutet Refactor der 3 Routen + ggf. eine VIEW `tickets_v` aus events.
--   Eigene Slice — Owner-getrieben.

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT,
  body TEXT,
  parent_ticket_id TEXT,
  workflow_state TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tickets_parent_ticket_id
  ON tickets (parent_ticket_id)
  WHERE parent_ticket_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tickets_workflow_state
  ON tickets (workflow_state)
  WHERE workflow_state IS NOT NULL;
