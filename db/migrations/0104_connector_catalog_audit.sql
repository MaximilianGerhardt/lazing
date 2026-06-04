-- ============================================================
-- 0104_connector_catalog_audit.sql — Connector Catalog Write Audit (ME-4)
--
-- Datum:  2026-05-24
-- Autor:  Claude Code (ACL-2 Security-Critic Härtung, ME-4)
-- ADR:    docs/adr/0006-connector-catalog-n2-demarcation.md
-- Plan:   docs/plans/2026-05-24_api-connector-layer.md D1 / D4
--
-- Table created:
--   connector_catalog_audit  — append-only N8 trace of catalog mutations
--
-- Why this exists (ME-4 / N8-Gap):
--   The connector-onboarding SOP (ACL-4) writes profiles via
--   upsertConnectorProfile()/deleteConnectorProfile() but those writes were
--   previously untraced. N8 ("Trace is evidence, not telemetry") requires a
--   "why/when did this change?" row for every catalog mutation.
--
-- Best-effort, NOT fail-closed (deliberate):
--   The connector catalog is non-sensitive (public API contracts only — see
--   ADR-0006). A failure to write the audit row therefore must NOT abort the
--   catalog write itself. This differs from N2 fail-closed audit on rag_chunks,
--   which IS sensitive. The application layer (lib/connectors/catalog.ts) wraps
--   the audit insert in try/catch so a broken audit table degrades gracefully.
--
-- N8:  append-only — rows are NEVER updated or deleted.
-- N10: content_hash = sha256 over canonical JSON of the audit row itself
--      (written by application layer). old_hash / new_hash capture the catalog
--      row's content_hash before/after the mutation for tamper-evident diffing.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS connector_catalog_audit (
  -- Application-minted UUID (crypto.randomUUID) with CCAUD- prefix.
  id            TEXT     PRIMARY KEY,

  -- Unix-ms timestamp of the mutation.
  ts            INTEGER  NOT NULL,

  -- What happened: 'upsert' (insert or update) or 'delete'.
  action        TEXT     NOT NULL
                         CHECK (action IN ('upsert','delete')),

  -- Who did it: a userId, or 'system' for SOP/automated writes.
  actor         TEXT     NOT NULL DEFAULT 'system',

  -- The connector provider slug that was mutated (lookup key).
  provider      TEXT     NOT NULL,

  -- The catalog row's content_hash BEFORE the mutation (NULL for first insert).
  old_hash      TEXT,

  -- The catalog row's content_hash AFTER the mutation (NULL for delete).
  new_hash      TEXT,

  -- N10: sha256 over canonical JSON of THIS audit row (sans content_hash).
  content_hash  TEXT     NOT NULL DEFAULT ''
);

-- Index for per-provider audit history (most common query).
CREATE INDEX IF NOT EXISTS idx_connector_catalog_audit_provider
  ON connector_catalog_audit (provider, ts);

-- Index for time-ordered global audit scan.
CREATE INDEX IF NOT EXISTS idx_connector_catalog_audit_ts
  ON connector_catalog_audit (ts);
