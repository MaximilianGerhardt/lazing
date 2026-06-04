-- 0021: schema_version (Phase Vers · 2026-04-27)
--
-- Append-only registry of the applied DB migrations.
-- One row per migration, NEVER update/delete: this is a historical
-- append log, not a state tracker. `db/client.ts:applyMigrationStatement`
-- does the INSERT in the same TX as the migration file itself,
-- so "table exists but row missing" is not possible
-- except on a manual rollback.
--
-- Schema:
--   version      numeric migration ID (1, 2, ..., 21, ...). PK for
--                unique identification, also UNIQUE.
--   filename     canonical file basename, e.g. "0021_schema_version.sql"
--   schema_hash  content sha256(:16) of the entire db/schema/**/*.ts
--                collection at the time of the migration apply. With this,
--                diagnostics can detect: "DB is on migration X, but the
--                current bundle would have expected schema hash Y" → drift.
--                NULL allowed for the initial backfill (old
--                migrations do not know their hash).
--   applied_at   epoch ms, INSERT timestamp
--
-- Read path for /api/diagnostics:
--   SELECT version, filename, schema_hash, applied_at
--     FROM schema_version
--    ORDER BY version DESC
--    LIMIT 1;

CREATE TABLE IF NOT EXISTS schema_version (
  version      INTEGER PRIMARY KEY,
  filename     TEXT NOT NULL,
  schema_hash  TEXT,
  applied_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schema_version_applied_at
  ON schema_version (applied_at DESC);
