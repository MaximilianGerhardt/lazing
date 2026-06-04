-- ============================================================
-- 0106_org_github_token_use_audit.sql — N8 Token-Use-Audit für Org-GitHub
--
-- Datum:  2026-05-24
-- Zweck:  Jede echte Nutzung des Org-GitHub-Tokens (decryptOrgToken →
--         Live-GitHub-API-Call) schreibt eine best-effort Audit-Row hier.
--
-- Sicherheits-Gebot:
--   - KEIN Token-Wert in dieser Tabelle (weder plaintext noch ciphertext).
--   - `purpose` = kurze Zweckbeschreibung (z.B. 'list-repos', 'token-resolver').
--   - `content_hash` = sha256(canonicalJSON({ org_id, purpose, ts })) — N10.
--   - Append-only: kein UPDATE, kein DELETE durch die Applikation.
--
-- N9:  org_id ist der Scope-Anker. Index für effiziente Org-bezogene Abfragen.
-- N10: content_hash = sha256(canonicalJSON(row ohne id + hash)) — Tamper-Evidenz.
-- N8:  Audit-Rows sind Evidence — append-only.
--
-- Idempotent via IF NOT EXISTS (laz.ing Convention — MIGRATION-NOTES.md).
-- ============================================================

CREATE TABLE IF NOT EXISTS org_github_token_use_audit (
  id           TEXT PRIMARY KEY,
  -- N9 Scope-Anker: immer WHERE org_id = ? in Queries.
  -- KEIN FK-Constraint (append-only audit, Org-Delete darf Log-Rows nicht
  -- kaskadieren — Forensik-Retention, DSGVO Art. 5(1)(e)).
  org_id       TEXT NOT NULL,
  -- Kurze Zweckbeschreibung (z.B. 'list-repos', 'token-resolver', 'unspecified').
  -- KEIN Token-Wert, KEIN PII.
  purpose      TEXT NOT NULL DEFAULT 'unspecified',
  -- Epoch-ms Zeitstempel des Token-Zugriffs.
  ts           INTEGER NOT NULL,
  -- N10: sha256(canonicalJSON({ org_id, purpose, ts })).
  content_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_github_token_use_audit_org
  ON org_github_token_use_audit(org_id);

CREATE INDEX IF NOT EXISTS idx_org_github_token_use_audit_ts
  ON org_github_token_use_audit(ts);
