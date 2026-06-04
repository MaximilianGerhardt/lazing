-- ============================================================
-- 0114_user_preferences.sql — User-Defaults / "Systemübergreifend" (2026-05-28)
--
-- Owner-Befund (verbatim, Live-Test 2026-05-28):
--   „Workspace erstellt. Nach Workspace-Erstellung nicht direkt in den
--    Workspace geswitched. Das muss gefixed werden. Vollzugriff war bereits
--    aktiviert. im neuen Workspace war es nicht aktiviert. Ggf. diese
--    Einstellung Systemübergreifend nutzbar machen."
--
-- Lösungsdesign:
--   Eine kleine additive Tabelle, die per-User-Defaults persistiert. Heute
--   ein einziges Feld (`default_permission_mode`) — die Tabelle ist bewusst
--   so geschnitten, dass weitere systemübergreifende User-Defaults
--   (Theme-Präferenz, bevorzugtes Engine-Modell, ...) später hier landen
--   können, ohne erneute Migration.
--
-- Substrat-Disziplin:
--   - N4 (additiv):       keine bestehende Tabelle (users, lazyos_permission_modes)
--                          wird geändert. Reine Aufwärts-Erweiterung.
--   - N1 (verbatim):       reason wird VERBATIM persistiert (kein .slice).
--                          source-Whitelist deckt die Audit-Wege ab.
--   - N6 (deterministisch): nur user_id PK; CHECK-Constraints für Mode-Whitelist.
--   - N9 (Identity):       user_id = ManifestCoord-Subject. KEIN harter FK
--                          (analog 0111/0112/0113 — DB toleriert Orphan-Scopes).
--   - N10 (Tamper):        content_hash (sha256 über kanonisches JSON) je Row;
--                          Application-Layer rechnet ihn — analog 0098.
--
-- Idempotenz:
--   CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS — sicher bei Re-Boot.
--   Schreibender Code nutzt INSERT … ON CONFLICT(user_id) DO UPDATE.
--
-- Wer schreibt diese Tabelle:
--   - lib/users/preferences-repo.ts (read + setDefaultPermissionMode)
--   - PATCH /api/permission/[workspaceId]/mode (folgt der letzten expliziten
--     Owner-Aktion: wenn Owner Vollzugriff einschaltet, soll das auch der
--     User-Default werden — Owner-Direktive 2026-05-28).
--   - POST   /api/workspaces (liest den User-Default und seedet den
--     lazyos_permission_modes-Row für den neuen Workspace SOFORT bei der
--     Anlage, damit die UI ohne zweiten Toggle den korrekten Modus zeigt).
-- ============================================================

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                  TEXT    PRIMARY KEY NOT NULL,
  -- NULL = kein Default gesetzt → Workspace startet im sicheren Default 'ask'.
  -- Whitelist gespiegelt aus lib-v1/permission/settings/schema.ts (PERMISSION_MODES).
  default_permission_mode  TEXT
                           CHECK (default_permission_mode IS NULL
                                  OR default_permission_mode IN ('freerein','freerein-with-audit','lane','ask')),
  -- N1 verbatim: warum hat der User diesen Default gesetzt (System / Toggle / API).
  reason                   TEXT,
  -- N8 Provenance: woher kam der Schreibvorgang (Whitelist hält das ehrlich).
  source                   TEXT    NOT NULL DEFAULT 'system'
                           CHECK (source IN ('system','permission-toggle','api','migration')),
  -- N10 Tamper-Evidenz: sha256 über kanonisches JSON, vom Application-Layer
  -- gefüllt. Default '' lässt SQLite-Migrationen idempotent laufen.
  content_hash             TEXT    NOT NULL DEFAULT '',
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

-- Lookup-Pfad ist immer „WHERE user_id = ?" (PK) — kein zweiter Index nötig.
