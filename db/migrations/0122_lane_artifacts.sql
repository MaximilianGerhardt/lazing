-- ============================================================
-- 0122_lane_artifacts.sql — Phase 2 W2.3 · Lanes C/E/F Engines
--
-- Schliesst die drei fehlenden Discovery-Lanes als EINE additive Tabelle:
--   - Lane C  Role Reverse Engineering   (Master-Kontext §5 Lane C)
--   - Lane E  Toolstack Replacement      (Master-Kontext §5 Lane E)
--   - Lane F  Mobile Human-in-the-Loop   (Master-Kontext §5 Lane F)
--
-- IST/SOLL-Befund (verbatim, N1): Diese Lanes existierten bisher NUR als
-- DAG-Stage-Namen im Merge-Contract (Integration-Plan §5: „4. Role / Decision /
-- Dependency Model · 5. Toolstack Replacement Model · 7. Mobile Surface Model")
-- und als Wissensform-`kind` — KEINE Engine. Diese Migration + die Engines in
-- lib/lanes/{role-reverse,toolstack,mobile-hitl}/ sind diese fehlende Schicht.
--
-- Master-Kontext §5 Lane C Output (verbatim, N1):
--   „Role model · Decision map · Dependency map · Automation boundary ·
--    kill / keep / augment criteria"
-- Master-Kontext §5 Lane E Output (verbatim, N1):
--   „replace / integrate / eliminate matrix · minimum replacement scope ·
--    domain-depth requirements · integration boundaries · migration/deployment
--    gates"
-- Master-Kontext §5 Lane F Output (verbatim, N1):
--   „hold-reply flow · pre-send nudge · decision card · context digest ·
--    ask-customer action · push rules · mobile surface contract"
--
-- Design-Entscheidung (EINE Tabelle mit kind-Diskriminator — analog 0120/0121):
--   `lane_artifacts` mit `lane`-Spalte (c|e|f) + `kind`-Spalte. Begruendung:
--     (a) Query-Effizienz — pro-Workspace Selects ueber EINEN Index
--         (workspace_id, lane, kind), nicht ueber disjunkte Tabellen.
--     (b) Additive Erweiterung — neue Artefakt-Arten erweitern den CHECK; die
--         Migration bleibt rein additiv (N4).
--     (c) Identisches Substrat-Muster wie innovation_artifacts (0121) —
--         dieselbe Append-only-/Hash-/Scope-Disziplin, ein Reviewer-Mental-Model.
--   Bewusst KEINE parallelen swarm_runs-/swarm_branches-Tabellen (Substrat-
--   Direktive): Discovery-Artefakte sind Evidenz, kein Branch-Tree.
--
-- Substrat-Disziplin:
--   - N1:  content / source_json werden VERBATIM persistiert (keine TEXT(N)-
--          Laengenbegrenzung in SQL, keine .slice/.substring in JS).
--   - N4:  rein additiv — keine bestehende Tabelle geaendert. Lane F setzt auf
--          dem bestehenden lib/push/* Substrat auf (kein neuer Push-Stack).
--   - N6:  CHECK-Constraints auf lane + kind.
--   - N8:  „Append-only" — Trigger blockt jede UPDATE auf Kern-Felder und DELETE
--          (Discovery-Artefakte sind Evidenz; eine Korrektur = neue Row mit
--          supersedes_id).
--   - N9:  workspace_id = ManifestCoord-Scope. Bewusst KEIN harter FK auf
--          workspaces (analog 0113/0118/0119/0120/0121).
--   - N10: content_hash (sha256 ueber kanonisches JSON) pro Row.
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS. Timestamps
-- INTEGER ms-Epoch. IDs TEXT (ULID mit Prefix LNA-).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. lane_artifacts — die Lane-C/E/F-Outputs
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lane_artifacts (
  id            TEXT    PRIMARY KEY NOT NULL,
  workspace_id  TEXT    NOT NULL,                        -- ManifestCoord-Scope (N9)
  lane          TEXT    NOT NULL
                CHECK (lane IN ('c', 'e', 'f')),         -- C=role-reverse, E=toolstack, F=mobile-hitl
  kind          TEXT    NOT NULL
                CHECK (kind IN (
                  -- Lane C — Role Reverse Engineering (§5 Lane C)
                  'role-model',           -- Rolle: Zweck, Output, Notwendigkeit
                  'decision-map',         -- Welche Entscheidungen trifft die Rolle
                  'dependency-map',       -- Handoff/Abhaengigkeit (X braucht Y vorher)
                  'automation-boundary',  -- kill/keep/augment + Automationsgrenze
                  -- Lane E — Toolstack Replacement (§5 Lane E)
                  'tool-replacement',     -- replace/integrate/eliminate + scope + domain-depth
                  -- Lane F — Mobile Human-in-the-Loop (§5 Lane F)
                  'hitl-rule'             -- hold-reply / pre-send-nudge / decision-card / push-rule-class
                )),
  content       TEXT    NOT NULL,                         -- N1 verbatim: Kern-Aussage des Artefakts
  source_json   TEXT,                                     -- JSON-Provenienz/Struktur, VERBATIM (N1)
  supersedes_id TEXT,                                     -- nullable, loest aeltere Row ab (Historie bleibt)
  content_hash  TEXT    NOT NULL,                         -- N10 sha256 ueber kanonisches JSON
  created_at    INTEGER NOT NULL                          -- ms-Epoch
);

-- Primary access pattern: pro Workspace + Lane + Kind.
CREATE INDEX IF NOT EXISTS idx_lane_artifacts_ws_lane_kind
  ON lane_artifacts (workspace_id, lane, kind);

-- Supersede-Kette: schneller Lookup, ob eine Row abgeloest wurde.
CREATE INDEX IF NOT EXISTS idx_lane_artifacts_supersedes
  ON lane_artifacts (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Hash-Lookup: Idempotenz bei Re-Run (gleicher Inhalt → gleicher contentHash).
CREATE INDEX IF NOT EXISTS idx_lane_artifacts_hash
  ON lane_artifacts (content_hash);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Append-only Trigger (N8)
--
-- Discovery-Artefakte sind Evidenz (N8: Trace ist Evidenz, nicht Telemetrie).
-- Eine Korrektur ist eine NEUE Row mit supersedes_id — kein in-place-UPDATE,
-- kein DELETE. Wie 0121 (innovation_artifacts) hat lane_artifacts KEIN
-- mutierbares Feld → der Trigger blockt JEDE UPDATE sowie DELETE.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS lane_artifacts_no_update
  BEFORE UPDATE ON lane_artifacts
BEGIN
  SELECT RAISE(ABORT, 'lane_artifacts is append-only — write a new row with supersedes_id (N1/N8/N10)');
END;

CREATE TRIGGER IF NOT EXISTS lane_artifacts_no_delete
  BEFORE DELETE ON lane_artifacts
BEGIN
  SELECT RAISE(ABORT, 'lane_artifacts is append-only — DELETE blocked (N8)');
END;
