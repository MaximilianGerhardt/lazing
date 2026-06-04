-- ============================================================
-- 0121_innovation_artifacts.sql — Phase IN · Lane D Innovation Mode
--
-- Owner-Direktive (verbatim, N1):
--
-- Master-Briefing §10.1 (verbatim) — Grundsatz Innovation Mode:
--   „Innovation bedeutet nicht wild kreativ sein. Innovation bedeutet:
--    Kontrollierte Regelverletzung mit anschliessendem Realitaetsabgleich."
--
-- Master-Briefing §10.2 (verbatim) — die Mechaniken:
--   „1. Current Reality zerlegen. 2. Zweck, Rollen, Entscheidungen und
--    Abhaengigkeiten sichtbar machen. 3. Annahmen offenlegen. 4. Annahmen
--    umkehren. 5. Cross-Domain-Analogien suchen. 6. Mehrere Zielzustaende
--    erzeugen. 7. Varianten roasten. 8. Praktikabilitaet pruefen. 9. Erst
--    danach planen."
--
-- Master-Briefing §10.4 (verbatim) — Artefakte vor Build:
--   „Reality Map, Role / Decision Map, Assumption Map, Reframe Set,
--    Concept Graphs, Roast Report, Merge Concept, Build Graph."
--
-- Design-Entscheidung (Single-Tabelle vs. N Tabellen — analog 0120):
--   EINE Tabelle `innovation_artifacts` mit `kind`-Spalte. Begruendung:
--     (a) Query-Effizienz — pro-Workspace Selects gehen ueber EINEN Index
--         (workspace_id, kind), nicht ueber disjunkte Tabellen.
--     (b) Schema-Erweiterung — neue Artefakt-Arten erweitern den CHECK-
--         Constraint; die Migration bleibt additiv.
--     (c) Concept-Graph: concept-node + concept-edge teilen sich die Tabelle;
--         eine Edge referenziert Nodes ueber source_json (kein eigener FK,
--         analog 0113/0120 Scope-Disziplin).
--
-- Substrat-Disziplin:
--   - N1:  content / source_json werden VERBATIM persistiert (keine TEXT(N)-
--          Laengenbegrenzung in SQL, keine .slice/.substring in JS).
--   - N4:  rein additiv — keine bestehende Tabelle geaendert. Der Contrarian-
--          Roast nutzt die BESTEHENDE counter-evidence-Surface-Logik
--          (lib/reasoning/reconcile.ts buildWhyQuestion-Muster) wieder.
--   - N6:  CHECK-Constraint auf kind.
--   - N8:  „Append-only" — der Trigger blockt jede UPDATE auf Kern-Felder
--          und blockt DELETE (Innovation-Artefakte sind Evidenz, kein
--          mutierbarer Draft; eine Korrektur = neue Row mit supersedes_id).
--   - N9:  workspace_id = ManifestCoord-Scope. Bewusst KEIN harter FK auf
--          workspaces (analog 0113/0118/0119/0120).
--   - N10: content_hash (sha256 ueber kanonisches JSON) pro Row.
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS. Timestamps
-- INTEGER ms-Epoch. IDs TEXT (ULID mit Prefix INV-).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. innovation_artifacts — die Innovation-Mode-Outputs (§10.4)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS innovation_artifacts (
  id            TEXT    PRIMARY KEY NOT NULL,
  workspace_id  TEXT    NOT NULL,                       -- ManifestCoord-Scope (N9)
  kind          TEXT    NOT NULL
                CHECK (kind IN (
                  'assumption',            -- §10.2.3 Annahme offenlegen
                  'reframe',               -- §10.2.4 Annahme umkehren / First-Principles
                  'cross-domain-analogy',  -- §10.2.5 analoge Loesung anderswo
                  'contrarian-roast',      -- §10.2.7 Variante roasten (counter-evidence)
                  'concept-node',          -- §10.4 Concept Graph — Knoten
                  'concept-edge'           -- §10.4 Concept Graph — Kante
                )),
  content       TEXT    NOT NULL,                        -- N1 verbatim: die Kern-Aussage des Artefakts
  source_json   TEXT,                                    -- JSON-Provenienz, VERBATIM (N1):
                                                         --   { rawTextHash?, fromAssumptionId?,
                                                         --     sourceNodeId?, targetNodeId?,
                                                         --     proposal?, verdict?, ... }
  supersedes_id TEXT,                                    -- nullable, loest aeltere Row ab (Historie bleibt)
  content_hash  TEXT    NOT NULL,                        -- N10 sha256 ueber kanonisches JSON
  created_at    INTEGER NOT NULL                         -- ms-Epoch
);

-- Primary access pattern: pro Workspace + Kind (z.B. „alle assumptions dieses
-- Workspace fuer die Assumption-Map").
CREATE INDEX IF NOT EXISTS idx_innovation_ws_kind
  ON innovation_artifacts (workspace_id, kind);

-- Supersede-Kette: schneller Lookup, ob eine Row abgeloest wurde.
CREATE INDEX IF NOT EXISTS idx_innovation_supersedes
  ON innovation_artifacts (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Hash-Lookup: Idempotenz bei Re-Run (gleicher Inhalt → gleicher contentHash).
CREATE INDEX IF NOT EXISTS idx_innovation_hash
  ON innovation_artifacts (content_hash);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Append-only Trigger (N8)
--
-- Innovation-Artefakte sind Evidenz (N8: Trace ist Evidenz, nicht Telemetrie).
-- Eine Korrektur ist eine NEUE Row mit supersedes_id — kein in-place-UPDATE,
-- kein DELETE. Anders als 0120 (das einen Review-Flow auf review_state
-- erlaubte) hat innovation_artifacts KEIN mutierbares Feld → der Trigger
-- blockt JEDE UPDATE sowie DELETE.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS innovation_artifacts_no_update
  BEFORE UPDATE ON innovation_artifacts
BEGIN
  SELECT RAISE(ABORT, 'innovation_artifacts is append-only — write a new row with supersedes_id (N1/N8/N10)');
END;

CREATE TRIGGER IF NOT EXISTS innovation_artifacts_no_delete
  BEFORE DELETE ON innovation_artifacts
BEGIN
  SELECT RAISE(ABORT, 'innovation_artifacts is append-only — DELETE blocked (N8)');
END;
