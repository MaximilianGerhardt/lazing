-- lazyOS initial schema (Phase 2)
-- Idempotent: only creates tables/indexes if absent.

CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  segment_id      TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  actor           TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  sensitivity     TEXT NOT NULL DEFAULT 'low',
  signature       TEXT,
  replayed_from   TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_segment_created
  ON events (segment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_entity
  ON events (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_type
  ON events (event_type);

CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  accent      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
