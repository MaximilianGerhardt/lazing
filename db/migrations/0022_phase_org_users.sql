-- Phase ORG SP-1 — Users-Tabelle (2026-04-27).
-- Multi-subject foundation: the subject `user:max` used to be hardcoded. Now
-- a first-class user concept exists. The SP-9 backfill creates Max as the first
-- user with a ULID and re-maps existing audit refs.
--
-- GDPR Art. 17 (right to be forgotten): soft-delete via status='deleted'
-- + deleted_at. On soft-delete the email is re-hashed to a pseudonymized
-- value so the audit trail does not break.

CREATE TABLE IF NOT EXISTS users (
  id                       TEXT    PRIMARY KEY,
  email                    TEXT    NOT NULL UNIQUE,
  email_verified_at        INTEGER,
  display_name             TEXT    NOT NULL,
  avatar_url               TEXT,
  locale                   TEXT    NOT NULL DEFAULT 'de-DE',
  status                   TEXT    NOT NULL DEFAULT 'active',
  onboarding_state         TEXT,
  onboarding_completed_at  INTEGER,
  deleted_at               INTEGER,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);
