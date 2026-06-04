-- Phase ORG SP-1 — org brand/legal fields (2026-04-27).
-- Extends the existing `organizations` table with fields that Phase ORG
-- needs for branding hierarchy + GDPR imprint.
--
-- SQLite does NOT support ADD COLUMN IF NOT EXISTS — we use
-- defensive pragmas: pragma_table_info gives the existing columns,
-- and we handle awkward application-layer skips in the migration runner.
-- This shows the standard case (fresh DB).

ALTER TABLE organizations ADD COLUMN logo_url            TEXT;
ALTER TABLE organizations ADD COLUMN wordmark_url        TEXT;
ALTER TABLE organizations ADD COLUMN brand_colors        TEXT;
ALTER TABLE organizations ADD COLUMN brand_voice         TEXT;
ALTER TABLE organizations ADD COLUMN address_lines       TEXT;
ALTER TABLE organizations ADD COLUMN vat_id              TEXT;
ALTER TABLE organizations ADD COLUMN imprint_md          TEXT;
ALTER TABLE organizations ADD COLUMN responsible_user_id TEXT;
ALTER TABLE organizations ADD COLUMN canonical_domain    TEXT;
ALTER TABLE organizations ADD COLUMN email_from          TEXT;
