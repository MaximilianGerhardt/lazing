-- Phase ORG SP-1 — audit log for auth/identity/org operations.
-- Separation from the event log (events.ts): business-domain events vs auth/identity audit.
-- GDPR Art. 5(1)(c): IP + UA only for an auth action.

CREATE TABLE IF NOT EXISTS audit_log (
  id              TEXT    PRIMARY KEY,
  ts              INTEGER NOT NULL,
  actor           TEXT    NOT NULL,
  action          TEXT    NOT NULL,
  org_id          TEXT,
  workspace_id    TEXT,
  target_user_id  TEXT,
  payload         TEXT,
  ip              TEXT,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_log (ts);
CREATE INDEX IF NOT EXISTS idx_audit_org   ON audit_log (org_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor);
