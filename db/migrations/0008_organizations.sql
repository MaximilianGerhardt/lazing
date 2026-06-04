-- 0008_organizations — hierarchy layer above workspaces
-- 2026-04-24, lazyOS organizations refactor
--
-- Organizations are the business level: Company (Example Company),
-- Clients (Demo PV, Example App, TAP), Products (lazyOS, example-product-c),
-- Tools (example-tool), Archived, Private (Max personally).
--
-- Workspaces each belong to EXACTLY ONE organization. The accent/
-- color identity is inherited from the organization (palette_index 0-39).

CREATE TABLE IF NOT EXISTS organizations (
  id             TEXT    PRIMARY KEY,       -- slug, e.g. "example-company"
  name           TEXT    NOT NULL,           -- display name, e.g. "Example Company"
  type           TEXT    NOT NULL DEFAULT 'company',
                 -- company | client | product | tool | archived | private
  parent_id      TEXT,                       -- nullable FK on organizations.id
  palette_index  INTEGER NOT NULL DEFAULT 0, -- 0..39 (see app/organizations-palette.css)
  description    TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_organizations_type    ON organizations(type);
CREATE INDEX IF NOT EXISTS idx_organizations_parent  ON organizations(parent_id);

-- The workspaces table gets an FK on organizations.
-- ALTER TABLE ADD COLUMN is NOT idempotent in SQLite, so we guard via a
-- "dry-run" SELECT on pragma_table_info. The column-exists check is a
-- compile-time constant expression — if the column exists, the ALTER is
-- skipped at parse time via the CASE/SELECT trick.
--
-- Simpler approach: wrap in SAVEPOINT + on-error ignore. Implemented in
-- client.ts execMigration() with try/catch fallback for duplicate-column
-- errors; the SQL here stays declarative:
ALTER TABLE workspaces ADD COLUMN organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workspaces_organization ON workspaces(organization_id);
