-- ============================================================
-- 0112_flow_studio.sql — Flow Studio Phase P1 (Datenmodell)
--
-- Quelle: docs/plans/2026-05-27_flow-studio-architecture.md §1.
--
-- Flow Studio ist ein chat-natives, visuelles SOP/Flow-Studio: Intent →
-- komponierte Mehr-Schritt-Pipeline (Nodes wie n8n/make), je Schritt Skill +
-- optional Tool/MCP/API → ausführbar + als wiederverwendbarer Standard
-- speicherbar.
--
-- Substrat-Disziplin (N4): KEINE neue Execution-Engine. Ein `flow_run` erzeugt
-- EINEN bestehenden `workstreams`-Run (Brücke: flow_runs.workstream_id); jeder
-- `flow_step` wird via lib/flow/compile.ts auf einen Plan-Step (analog
-- workstream_plan_steps) gemappt und im bestehenden plan-executor/tier-
-- orchestrator (P2) ausgeführt.
--
-- Owner-Entscheidung §7.4: Flow ≠ zwingend SOP. Getrennte Konzepte, aber ein
-- Flow KANN als SOP gespeichert werden → flow_templates.sop_id ist ein
-- OPTIONALER Soft-FK auf sops.id (NICHT als echte FK erzwungen, analog
-- github_repo_id in 0111: das Soft-FK-Ziel kann fehlen / global sein).
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX IF NOT EXISTS (Konvention wie 0111).
-- Timestamps sind INTEGER (ms-Epoch). IDs sind TEXT (ULID mit Prefix).
-- Scope (workspace_id/org_id) ist ManifestCoord-analog (N9): Personal · Org ·
-- Workspace. Bewusst KEINE harten FKs auf workspaces/organizations (diese DB
-- toleriert Orphan-Scope-Rows zur Laufzeit — siehe db/client.ts FK-Notiz).
-- ============================================================

-- flow_templates: der wiederverwendbare "Standard".
CREATE TABLE IF NOT EXISTS flow_templates (
  id            TEXT    PRIMARY KEY NOT NULL,
  workspace_id  TEXT,                          -- scope (ManifestCoord-analog), NULL = global/template
  org_id        TEXT,                          -- scope (ManifestCoord-analog)
  name          TEXT    NOT NULL,
  description    TEXT,
  sop_id        TEXT,                          -- OPTIONALER Soft-FK auf sops.id (ein Flow KANN eine SOP sein)
  graph_json    TEXT    NOT NULL,              -- Nodes+Edges (Visualisierung + Ausführungs-DAG)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- flow_steps: ein Node im Flow.
CREATE TABLE IF NOT EXISTS flow_steps (
  id              TEXT    PRIMARY KEY NOT NULL,
  flow_id         TEXT    NOT NULL,            -- gehört zu flow_templates.id
  idx             INTEGER NOT NULL DEFAULT 0,  -- stabile Quell-Ordnung (Layout / Tie-break)
  label           TEXT,
  skill           TEXT,                        -- role-skill-map-Key (Aufbau/Copy/Design/…)
  tool_kind       TEXT,                        -- null | 'connector' | 'mcp' | 'engine'
  connector_id    TEXT,                        -- OPTIONALER Soft-FK auf connectors (imagegen2/Higgsfield/Heygen/…)
  config_json     TEXT,                        -- Step-Parameter (JSON)
  depends_on_json TEXT,                        -- DAG-Kanten: JSON-Array von flow_steps.id (Vorgänger)
  created_at      INTEGER NOT NULL
);

-- flow_runs: eine Ausführung (mappt auf EINEN workstream → wiederverwendet Orchestrierung).
CREATE TABLE IF NOT EXISTS flow_runs (
  id             TEXT    PRIMARY KEY NOT NULL,
  flow_id        TEXT,                          -- welches Template lief (flow_templates.id)
  workspace_id   TEXT,                          -- scope (ManifestCoord-analog)
  workstream_id  TEXT,                          -- Brücke zum bestehenden tier-orchestrator (workstreams.id)
  status         TEXT    NOT NULL DEFAULT 'pending', -- pending|running|done|failed|cancelled
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flow_templates_ws ON flow_templates(workspace_id);
CREATE INDEX IF NOT EXISTS idx_flow_steps_flow    ON flow_steps(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_flow      ON flow_runs(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_ws        ON flow_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_ws_stream ON flow_runs(workstream_id);
