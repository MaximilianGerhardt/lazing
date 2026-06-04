-- 0124_subchat_attachments.sql
-- Anhänge (Dokumente/Medien/Fotos) für Sub-Chat-Nachrichten — WhatsApp-Standard
-- für externe Kunden UND internes Team (Gathering-Intelligence, 2026-06-02).
-- JSON-Array von { artifactId, filename, mime, bytes, kind }. Bytes liegen im
-- Cloud-Artifact-Store (lib/cloud); hier nur die Referenz. Additiv + idempotent.
--
-- SQLite kann "ADD COLUMN IF NOT EXISTS" nicht; der Runner toleriert den
-- "duplicate column name"-Fehler bei Re-Runs (siehe db/client.ts).
ALTER TABLE subchat_messages ADD COLUMN attachments TEXT;
