-- lazyOS Sprint 2 · Section 7I — work products (artifacts per ticket).
-- Idempotent: IF NOT EXISTS throughout.
--
-- Relationship to tickets: loose. Tickets are only a projection from events,
-- hence no FK constraint. Referential integrity is enforced at the service
-- via projectTicket(). ticket_id is a TCK-ULID.
--
-- Soft-delete: status='superseded' instead of DROP ROW, so the history
-- stays auditable.

CREATE TABLE IF NOT EXISTS work_products (
  id           TEXT PRIMARY KEY,
  ticket_id    TEXT NOT NULL,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  mime         TEXT,
  bytes        INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'draft',
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_products_ticket
  ON work_products (ticket_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_work_products_status
  ON work_products (status);
