# Migration Notes

Reihenfolge + Geschichte aller Schema-Migrations. Diese Datei ist Doku, nicht
ausgefuehrter Code — die echten SQL-Files liegen daneben und werden in
`db/client.ts:MIGRATIONS` registriert.

## Aktive Migrationen

| Datei | Zweck | Datum |
|---|---|---|
| `0001_initial.sql` | Events + Tickets-Projection-Basis | 2026-04 |
| `0002_workspaces.sql` | Workspaces-Tabelle | 2026-04 |
| `0003_heartbeats.sql` | Heartbeat-Probes + Decisions | 2026-04 |
| `0004_routines.sql` | Cron-Routinen + Runs | 2026-04 |
| `0005_work_products.sql` | Ticket-Anhaenge | 2026-04 |
| `0006_claude_sessions.sql` | Persistierte Claude-CLI-Sessions | 2026-04 |
| `0007_workflow_state.sql` | FSM-State-Spalte auf Tickets | 2026-04 |
| `0008_organizations.sql` | Optionaler Org-Layer ueber Workspaces | 2026-04 |
| `0009_workstreams.sql` | Multi-Agent-Container | 2026-04-25 |
| `0011_skills.sql` | Skill-First-Class entities + Built-In-Seeds | 2026-04-25 |
| `0017_client_visibility.sql` | Cross-process client visibility + chat_msg legacy unique | 2026-04-26 |
| `0018_streaming_snapshots.sql` | Ephemerale Tabelle fuer Reload-Recovery V2 | 2026-04-27 |

## Lücken und übersprungene Nummern

### `0010` — bewusst übersprungen (2026-04-25)

Reservierter Slot fuer eine `classification_index`-Migration die spaeter
in **Phase C (Self-Calibration)** eingefuegt wird:

```sql
-- TODO bei Phase C:
CREATE INDEX idx_ws_embedded ON workstreams(classification_embedding)
  WHERE classification_embedding IS NOT NULL;
```

Wird **nicht** mit der naechsten Phase gemerged — `0010` bleibt frei bis
Phase C den Index tatsaechlich braucht. Bis dahin ist die Spalte da
(aus `0009_workstreams.sql`), aber ohne Index. Performance unkritisch
solange < 1k Workstreams.

## Idempotenz-Pattern (Pflicht)

Alle Migrations MUESSEN `IF NOT EXISTS` nutzen — sowohl auf Tabellen
als auch auf Indices. `db/client.ts:applyMigrationStatement` toleriert
zusaetzlich `duplicate column name` als idempotent (fuer
`ALTER TABLE … ADD COLUMN`-Statements bei Re-Runs).

```sql
-- gut:
CREATE TABLE IF NOT EXISTS skills (...);
CREATE INDEX IF NOT EXISTS idx_skills_active ON skills(...);

-- schlecht:
CREATE TABLE skills (...);  -- crasht beim 2. Boot
```

## Gap-Audit

Auf VPS: `sqlite3 ~/.lazyos/lazyos.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"`
sollte alle Tabellen aus den Migrations-Files spiegeln. Bei Drift:
Migrations re-run via Service-Restart (idempotent).
