-- ============================================================
-- 0105_connector_calls.sql — Connector Call Approvals + Audit (ACL-5-C)
--
-- Datum:  2026-05-24
-- Plan:   docs/plans/2026-05-24_acl5-auto-connect.md  Wave 1 / ACL5-C
--
-- Zwei Tabellen:
--   `connector_call_approvals` — Trust-Level ('ask'|'auto') pro Connector+Scope.
--   `connector_call_audit`     — Append-only Audit-Log (N8/N10) für jeden
--                                Preview/Approve/Invoke/Deny/Dry-Run-Event.
--
-- Design-Entscheidungen:
--   D1  trust DEFAULT 'ask' — fail-closed Richtung Bestätigung.
--       'auto' muss explizit gesetzt werden (setTrust). Never auto by default.
--   D2  scope_kind CHECK('org'|'workspace') — exakt zwei Ebenen.
--       UNIQUE(scope_kind, scope_id, provider) — eine Trust-Einstellung pro Scope+Provider.
--   D3  payload_hash NIE der rohe Payload. connector_call_audit speichert nur
--       sha256(canonical-JSON(payload)) — kein Secret, kein PII im Audit-Log (N8-safe).
--   D4  content_hash N10: sha256 über canonical JSON jeder Audit-Zeile (wie 0100_api_credentials).
--   D5  connector_call_audit hat KEIN FK auf connector_call_approvals —
--       Audit-Log bleibt erhalten auch nach Delete/Änderung des Trust-Eintrags.
--   D6  Idempotent via IF NOT EXISTS (Migration-Konvention).
--
-- Isolation-Garantie (N9):
--   Alle Queries MÜSSEN scope_kind + scope_id als WHERE-Anker setzen.
--   lib/connectors/trust.ts enforced dies strukturell.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. connector_call_approvals — Trust-Level pro Connector+Scope
--
-- Speichert ob ein Connector in einem Scope ohne Bestätigung ('auto') oder
-- immer mit Bestätigung ('ask') aufgerufen werden darf.
-- Default 'ask' = fail-closed: kein unbeaufsichtigter Connector-Call, bis
-- der Owner explizit auf 'auto' umschaltet.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_call_approvals (
  id          TEXT    PRIMARY KEY,

  -- 'org' | 'workspace' — exakt zwei Ebenen (N9 Scope-Anker).
  scope_kind  TEXT    NOT NULL CHECK (scope_kind IN ('org', 'workspace')),

  -- org_id oder workspace_id je nach scope_kind.
  scope_id    TEXT    NOT NULL,

  -- Provider-Identifier aus connector_catalog, z.B. 'heygen', 'openai'.
  provider    TEXT    NOT NULL,

  -- Trust-Level:
  --   'ask'   (default, fail-closed) — jeder Call braucht explizite Freigabe.
  --   'auto'  — Connector darf Calls ohne manuelle Bestätigung machen.
  --             Wird nur gesetzt wenn Owner explizit setTrust('auto') aufruft.
  trust       TEXT    NOT NULL DEFAULT 'ask'
              CHECK (trust IN ('ask', 'auto')),

  -- Wer den Trust-Level gesetzt hat (userId oder 'system').
  set_by      TEXT    NOT NULL DEFAULT 'system',

  -- Optionale Begründung warum dieser Trust-Level gesetzt wurde (N8-Rückverfolgbarkeit).
  reason      TEXT,

  -- N10: sha256 über canonical JSON dieser Row (ohne dieses Feld selbst).
  -- Tamper-Evidenz analog zu api_credentials.
  content_hash TEXT   NOT NULL DEFAULT '',

  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,

  -- Ein Trust-Eintrag pro (scope_kind, scope_id, provider).
  UNIQUE (scope_kind, scope_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_connector_call_approvals_scope
  ON connector_call_approvals (scope_kind, scope_id);

CREATE INDEX IF NOT EXISTS idx_connector_call_approvals_provider
  ON connector_call_approvals (provider);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. connector_call_audit — Append-only N8/N10 Audit-Log
--
-- Jeder Phase-Übergang eines Connector-Calls schreibt eine Zeile:
--   'preview'   — S5: Call wurde dem Owner zur Ansicht präsentiert.
--   'approve'   — S6: Owner hat den Call explizit freigegeben.
--   'invoke'    — Echter Call (live=1) oder Dry-Run (live=0) wurde ausgeführt.
--   'deny'      — Call wurde durch Gate (S4/S5/S6) blockiert.
--   'dry-run'   — LAZYOS_CONNECTOR_LIVE=off: simulierter Call, kein Netzwerk.
--
-- KEIN FK auf connector_call_approvals — bleibt erhalten nach Trust-Änderungen.
-- payload_hash = sha256(canonical-JSON(payload)) — NICHT der rohe Payload.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS connector_call_audit (
  id          TEXT    PRIMARY KEY,

  -- Zeitstempel des Events (epoch-ms).
  ts          INTEGER NOT NULL,

  -- Scope-Anker (N9).
  scope_kind  TEXT    NOT NULL CHECK (scope_kind IN ('org', 'workspace')),
  scope_id    TEXT    NOT NULL,

  -- Provider aus connector_catalog.
  provider    TEXT    NOT NULL,

  -- Capability-Name aus connector_capabilities.name.
  capability  TEXT    NOT NULL,

  -- Aufrufender User (userId oder 'system').
  user_id     TEXT    NOT NULL,

  -- Phase des Audit-Events:
  --   'preview'   — präsentiert zur Ansicht
  --   'approve'   — vom Owner freigegeben
  --   'invoke'    — ausgeführt (live oder dry-run)
  --   'deny'      — durch Gate blockiert
  --   'dry-run'   — simuliert, kein Netzwerk
  phase       TEXT    NOT NULL
              CHECK (phase IN ('preview', 'approve', 'invoke', 'deny', 'dry-run')),

  -- 1 = echter Netzwerk-Call; 0 = Dry-Run / Simulation.
  -- Bei 'preview'/'approve'/'deny': immer 0.
  live        INTEGER NOT NULL DEFAULT 0
              CHECK (live IN (0, 1)),

  -- sha256 über canonical JSON des Call-Payloads — NICHT der Payload selbst.
  -- Verhindert dass Secrets oder PII im Audit-Log landen (D3).
  -- NULL wenn kein Payload bekannt (z.B. bei 'deny' vor Payload-Konstruktion).
  payload_hash TEXT,

  -- Kurze menschenlesbare Zusammenfassung des Ergebnisses.
  -- z.B. 'status=200 duration=340ms' oder 'error: timeout' oder 'dry-run: mocked'.
  -- NIE rohe API-Response-Bodies (können PII enthalten).
  result_summary TEXT,

  -- 1 = Phase erfolgreich (invoke→200, approve→OK, preview→shown);
  -- 0 = Phase fehlgeschlagen (invoke→error, deny, timeout).
  success     INTEGER NOT NULL DEFAULT 0
              CHECK (success IN (0, 1)),

  -- Grund für Deny oder Fehler; NULL bei Erfolg.
  reason      TEXT,

  -- N10: sha256 über canonical JSON dieser Row (ohne dieses Feld selbst).
  content_hash TEXT   NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_connector_call_audit_ts
  ON connector_call_audit (ts DESC);

CREATE INDEX IF NOT EXISTS idx_connector_call_audit_scope
  ON connector_call_audit (scope_kind, scope_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_connector_call_audit_provider
  ON connector_call_audit (provider, ts DESC);

CREATE INDEX IF NOT EXISTS idx_connector_call_audit_user
  ON connector_call_audit (user_id, ts DESC);
