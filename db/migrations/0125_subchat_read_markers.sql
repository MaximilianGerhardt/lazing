-- 0125_subchat_read_markers.sql — Read-Marker für Sub-Chats (Gathering-Intelligence, P2)
-- Pro (Sub-Chat, User) der Zeitstempel der zuletzt gelesenen Nachricht.
-- Grundlage für Unread-Badge im Hauptchat. Workspace-scoped via subchat_id (N2/N9).
-- Konvention: CREATE TABLE/INDEX IF NOT EXISTS (idempotent, Single-User-MVP).

CREATE TABLE IF NOT EXISTS subchat_read_markers (
  subchat_id   TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  last_read_ts INTEGER NOT NULL,
  PRIMARY KEY (subchat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_subchat_read_markers_user ON subchat_read_markers (user_id);
