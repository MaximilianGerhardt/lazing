CREATE TABLE IF NOT EXISTS workstreams (
  id TEXT PRIMARY KEY,                       -- WS-<ulid>
  workspace_id TEXT NOT NULL,                -- Gehört zu welchem lazyOS-Workspace
  name TEXT NOT NULL,                        -- Auto-Titel (erster Prompt) oder manuell
  primary_session_id TEXT,                    -- aktive Claude-Session-UUID
  primary_ticket_id TEXT,                     -- Master-Plan-Ticket
  tier_mix TEXT,                              -- JSON: {opus:N, sonnet:M, haiku:K}
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused | done | archived
  cost_cents INTEGER NOT NULL DEFAULT 0,     -- API-äquivalente Kosten (Anzeige)
  quality_score REAL,                         -- 0..5, gewichteter Lead-Rating
  classification_embedding TEXT,              -- JSON-Array (384 dim) für Self-Calibration
  description TEXT,                           -- optional manuell hinzugefügt
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workstreams_workspace
  ON workstreams (workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workstreams_session
  ON workstreams (primary_session_id);

CREATE INDEX IF NOT EXISTS idx_workstreams_status
  ON workstreams (status, updated_at DESC);
