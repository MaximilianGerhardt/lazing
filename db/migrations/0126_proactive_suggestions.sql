-- 0126_proactive_suggestions.sql — Server-pre-generierte proaktive Operator-Vorschläge
-- (Proactivity-Goal, 2026-06-02). Ein server-seitiger Watcher generiert beim
-- Eintreffen einer EXTERNEN Sub-Chat-Nachricht EINEN operator-facing nächsten
-- Schritt (claude-gated, best-effort) und legt ihn hier ab. Der Hauptchat liest
-- ihn vor-generiert; NIEMALS Auto-Send. Append-light: dismissed_at-only-Update.
-- Workspace-scoped (N2/N9 via workspace_id). Konvention: IF NOT EXISTS, idempotent.

CREATE TABLE IF NOT EXISTS proactive_suggestions (
  id            TEXT PRIMARY KEY,
  subchat_id    TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  suggestion    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  dismissed_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_proactive_suggestions_subchat ON proactive_suggestions (subchat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_proactive_suggestions_workspace ON proactive_suggestions (workspace_id);
