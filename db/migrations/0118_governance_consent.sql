-- ============================================================
-- 0118_governance_consent.sql — Phase 2 W2.1 · Lane G Governance
--
-- Master-Briefing §13.2 (verbatim, N1):
--   „Opt-in · Transparenz · Zweckbindung · Datenminimierung ·
--    Pause/Stop jederzeit · Redaction · keine geheimen Screenshots ·
--    keine Passwörter · keine privaten Daten · Review durch betroffene
--    Person · Betriebsrat/Arbeitsrecht beachten"
-- Master-Briefing §7.2 (verbatim, N1):
--   „Imported context must not auto-run."
-- Master-Kontext §6 Stage 1 (verbatim, N1):
--   „Governance Gate Contract" — load-bearing.
-- Integration-Plan §4 Lane G (verbatim, N1):
--   „Consent Levels · Retention Policy · Raw vs Derived Data Policy ·
--    Source Trace Rules · No-auto-run Gate Matrix ·
--    audit/provenance requirements"
--
-- Lane G ist die FUNDAMENTAL-Lane (Stage 1) — sie definiert, was JEDE
-- andere Lane darf/muss. Sie muss zuerst gemerged werden.
--
-- Drei additive Tabellen (alle scoped per workspace_id = N9 ManifestCoord):
--
--   consent_grants    — pro Datenquelle (whatsapp / telegram / voice / …)
--                       ein Consent-Level. Append-only-Trigger blockt DELETE
--                       und UPDATE der core-Felder (id, granted_at,
--                       content_hash). Revoke = NEUE Row mit revoked_at
--                       gefüllt (die alte Row bleibt als Historie erhalten).
--                       reason_text VERBATIM (N1) — kein .slice, kein
--                       Kürzen. content_hash (sha256 über kanonisches JSON,
--                       N10).
--
--   source_traces     — Raw/Derived-Provenance-Kette. Jede aus einer Daten-
--                       quelle abgeleitete Einheit (chunk, belief, message)
--                       trägt eine source_trace-Row, die per
--                       derived_from_trace auf ihren Ursprung zeigt. raw-
--                       Retention default 30d, derived 365d.
--
--   governance_audit  — append-only Audit-Trail jeder Entscheidung (allowed
--                       / denied / requires-approval) inkl. verbatim reason
--                       (N1) und content_hash (N10). Pattern analog zu
--                       lazyos_permission_audit (0098). Append-only-Trigger
--                       blockt DELETE.
--
-- Substrat-Disziplin:
--   - N1:  reason / reason_text / note verbatim — keine Kürzung in SQL,
--          keine TEXT(N)-Längenbegrenzung.
--   - N4:  rein additiv — keine bestehende Tabelle geändert.
--   - N8:  Trace ist Evidence — Append-only-Trigger auf consent_grants +
--          governance_audit. workstream_decisions-Pattern (0071) als
--          Vorlage.
--   - N9:  workspace_id = ManifestCoord-Scope. Bewusst KEIN harter FK auf
--          workspaces (analog 0113/0111/0112 — Orphan-Scope-Rows zur
--          Laufzeit toleriert).
--   - N10: content_hash je Row der lerntragenden Tabellen (consent_grants,
--          source_traces, governance_audit).
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS. Timestamps
-- INTEGER ms-Epoch (analog flow_* / workspace_beliefs). IDs TEXT (ULID mit
-- Prefix CGT-/STR-/GAU-).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. consent_grants — Owner-Direktive §13.2 (Opt-in · Pause/Stop · Review)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consent_grants (
  id              TEXT    PRIMARY KEY NOT NULL,
  workspace_id    TEXT    NOT NULL,                  -- ManifestCoord-Scope (N9)
  user_id         TEXT    NOT NULL,                  -- die betroffene Person (§13.2 „Review durch betroffene Person")
  data_source     TEXT    NOT NULL,                  -- 'whatsapp' | 'telegram' | 'voice' | 'meeting' | 'email' | 'browser-shadow' | 'screen-capture' | 'keystroke-capture' | 'workspace-derive'
  level           TEXT    NOT NULL                   -- ConsentLevel
                  CHECK (level IN ('none','read-only','read-derive','read-derive-act','full-automation')),
  scope_json      TEXT,                              -- optionales JSON: {timeWindow?, dataMin?}
  reason_text     TEXT    NOT NULL,                  -- §13.2 verbatim Begründung (N1)
  granted_at      INTEGER NOT NULL,                  -- ms-Epoch
  revoked_at      INTEGER,                           -- nullable; gesetzt → Grant zurückgenommen
  content_hash    TEXT    NOT NULL                   -- N10 sha256 kanonisches JSON
);

CREATE INDEX IF NOT EXISTS idx_consent_grants_ws
  ON consent_grants (workspace_id, user_id, data_source);

CREATE INDEX IF NOT EXISTS idx_consent_grants_ws_user
  ON consent_grants (workspace_id, user_id);

CREATE INDEX IF NOT EXISTS idx_consent_grants_granted_at
  ON consent_grants (granted_at);

-- Append-only-Trigger: DELETE komplett verboten.
CREATE TRIGGER IF NOT EXISTS consent_grants_no_delete
BEFORE DELETE ON consent_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'consent_grants is append-only — DELETE forbidden (N8)');
END;

-- Append-only-Trigger: core-Felder immutable (id, granted_at, content_hash).
-- revoked_at MUSS aktualisierbar bleiben — Revoke ist ein UPDATE auf diese
-- Spalte (alternativ: neue Row, dann wird revoked_at via Repo-Schicht
-- gesetzt). Wir erlauben das Toggle nur durch eine spezielle Repo-Operation,
-- die zusätzlich zur revoked_at-Spalte eine Decision-Row in workspace_decisions
-- schreibt (siehe lib/governance/consent.ts).
CREATE TRIGGER IF NOT EXISTS consent_grants_no_update_grant_fields
BEFORE UPDATE OF id, workspace_id, user_id, data_source, level, scope_json,
                 reason_text, granted_at, content_hash
ON consent_grants
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'consent_grants core fields are immutable (N8) — only revoked_at may be set');
END;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. source_traces — Raw/Derived-Provenance (§4 Lane G)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS source_traces (
  id                     TEXT    PRIMARY KEY NOT NULL,
  workspace_id           TEXT    NOT NULL,           -- ManifestCoord-Scope (N9)
  data_source            TEXT    NOT NULL,           -- analog consent_grants.data_source
  external_id            TEXT,                       -- optionale externe ID (whatsapp-message-id, …)
  content_hash           TEXT    NOT NULL,           -- N10 — sha256 über den Original-Inhalt
  derived_from_trace     TEXT,                       -- nullable; Soft-FK auf source_traces.id (Derive-Kette)
  raw_retention_until    INTEGER,                    -- ms-Epoch; nach diesem Zeitpunkt darf der Raw-Inhalt entfernt werden
  created_at             INTEGER NOT NULL,

  FOREIGN KEY (derived_from_trace) REFERENCES source_traces(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_source_traces_ws
  ON source_traces (workspace_id, data_source, created_at);

CREATE INDEX IF NOT EXISTS idx_source_traces_hash
  ON source_traces (content_hash);

CREATE INDEX IF NOT EXISTS idx_source_traces_derived_from
  ON source_traces (derived_from_trace);

-- ─────────────────────────────────────────────────────────────────────────
-- 3. governance_audit — N8 Trace-as-Evidence
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS governance_audit (
  id              TEXT    PRIMARY KEY NOT NULL,
  workspace_id    TEXT    NOT NULL,                  -- ManifestCoord-Scope (N9)
  user_id         TEXT    NOT NULL,                  -- wer hat die Entscheidung getriggert
  action          TEXT    NOT NULL,                  -- ActionKind: 'connector-invoke-live' | …
  data_source     TEXT,                              -- nullable; nur bei daten-bezogenen actions
  decision        TEXT    NOT NULL                   -- 'allowed' | 'denied' | 'requires-approval'
                  CHECK (decision IN ('allowed','denied','requires-approval')),
  reason          TEXT    NOT NULL,                  -- VERBATIM N1
  content_hash    TEXT    NOT NULL,                  -- N10
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_governance_audit_ws
  ON governance_audit (workspace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_governance_audit_ws_user
  ON governance_audit (workspace_id, user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_governance_audit_action
  ON governance_audit (action, created_at);

CREATE TRIGGER IF NOT EXISTS governance_audit_no_delete
BEFORE DELETE ON governance_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'governance_audit is append-only — DELETE forbidden (N8)');
END;

CREATE TRIGGER IF NOT EXISTS governance_audit_no_update
BEFORE UPDATE ON governance_audit
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'governance_audit is append-only — UPDATE forbidden (N8)');
END;
