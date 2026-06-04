-- ============================================================
-- 0120_expertise_knowledge_forms.sql — Phase 2 W2.2 · Lane B Expertise Compiler
--
-- Owner-Direktive (verbatim, N1):
--
-- Master-Briefing §8.1 (verbatim):
--   „Experte erklaert oder handelt, System extrahiert Begriffe, Regeln,
--    Ausnahmen, Entscheidungen und Qualitaetskriterien."
--
-- Master-Briefing §8.2 (verbatim) — die 12 Wissensformen:
--   „Glossary Entry · Principle · If-Then Rule · Exception · Tactic ·
--    Role Judgment · Handoff Dependency · Quality Criterion ·
--    Simulation Case · Eval Question · SOP Step · Open Unknown."
--
-- Master-Briefing §8.3 (verbatim, Beispiel):
--   „Begriff: PV-Planung bedeutet nicht nur Dach zeichnen, sondern
--    Modulbelegung, Stringing, Wechselrichterauswahl, Speicher, Ertrag,
--    Angebot. Regel: Wenn PV-Sol ersetzt werden soll, dann muss die
--    technische Planungslogik deterministisch oder expertengerostet sein."
--
-- Master-Briefing §5 (verbatim, warum RAG alleine nicht reicht):
--   „RAG speichert und findet Informationen. Aber RAG garantiert nicht,
--    dass ein LLM die richtigen Begriffe verwendet, Entscheidungen korrekt
--    abstrahiert, Ausnahmen erkennt, Rollen realistisch simuliert,
--    fachliche Berechnungen nicht halluziniert, nicht zu schnell
--    generalisiert."
--
-- Integration-Plan §4 Lane B Outputs (verbatim):
--   „Glossary Entries · Principles · If-Then Rules · Exceptions ·
--    Tactics · Eval Cases · Belief Candidates."
--
-- Design-Entscheidung (Single-Tabelle vs. 12 Tabellen):
--   Eine Tabelle `knowledge_forms` mit `kind`-Spalte. Begründung:
--     (a) Query-Effizienz — pro-Workspace Selects gehen ueber EINEN Index
--         (workspace_id, kind, review_state), nicht ueber 12 disjunkte
--         Tabellen mit getrennten Migrations.
--     (b) Schema-Erweiterung — neue Wissensformen erweitern den CHECK-Constraint;
--         die Migration bleibt additiv.
--     (c) Cross-Kind-Queries — Owner-Review-UI listet alle pending Items
--         eines Workspace; das ist ein einziger Scan.
--   Spezialfelder pro Kind (z.B. `term` fuer glossary, `example_cases_json`
--   fuer if-then-rule) sind nullable; pro Kind validiert das Code-Modul
--   (lib/lanes/expertise-compiler/glossary.ts / principles.ts / rules.ts).
--
-- Substrat-Disziplin:
--   - N1:  statement / rationale / term / example_cases_json /
--          counter_cases_json werden VERBATIM persistiert (keine TEXT(N)-
--          Laengenbegrenzung in SQL, keine .slice/.substring in JS).
--   - N4:  rein additiv — keine bestehende Tabelle geaendert. Belief-
--          Kandidaten werden NACH human-review per upsertBelief in das
--          bestehende workspace_beliefs (0113) gespiegelt.
--   - N6:  CHECK-Constraints auf kind, review_state, confidence (0..1).
--   - N8:  „Append-only-Light" — der Trigger blockt id/kind/term/statement/
--          content_hash-Mutation und blockt DELETE; UPDATE auf review_state
--          + supersedes_id + updated_at ist erlaubt (Review-Flow + Supersede-
--          Kette).
--   - N9:  workspace_id = ManifestCoord-Scope. Bewusst KEIN harter FK auf
--          workspaces (analog 0113/0118/0111/0112).
--   - N10: content_hash (sha256 ueber kanonisches JSON) pro Row.
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS. Timestamps
-- INTEGER ms-Epoch. IDs TEXT (ULID mit Prefix KFM-).
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. knowledge_forms — die 12 Wissensformen (§8.2)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_forms (
  id                 TEXT    PRIMARY KEY NOT NULL,
  workspace_id       TEXT    NOT NULL,                  -- ManifestCoord-Scope (N9)
  kind               TEXT    NOT NULL
                     CHECK (kind IN (
                       'glossary',
                       'principle',
                       'if-then-rule',
                       'exception',
                       'tactic',
                       'role-judgment',
                       'handoff-dependency',
                       'quality-criterion',
                       'simulation-case',
                       'eval-question',
                       'sop-step',
                       'open-unknown'
                     )),
  term               TEXT,                              -- glossary-Begriff (nullable, nur fuer 'glossary')
  statement          TEXT    NOT NULL,                  -- N1 Owner-Wortlaut: die Hauptaussage
  rationale          TEXT,                              -- N1 Owner-Wortlaut: warum dies wichtig ist (nullable)
  example_cases_json TEXT,                              -- JSON-Array von Strings (illustrative Faelle); N1 verbatim
  counter_cases_json TEXT,                              -- JSON-Array von Strings (Ausnahmen); N1 verbatim
  domain             TEXT,                              -- z.B. 'pv-planning', 'crm', 'website-build'
  source_json        TEXT,                              -- {intakeEventId?, userInputTurnId?}
  confidence         REAL    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  review_state       TEXT    NOT NULL
                     CHECK (review_state IN ('pending-review','approved','rejected','superseded')),
  supersedes_id      TEXT,                              -- nullable, loest aeltere Row ab (Historie bleibt)
  content_hash       TEXT    NOT NULL,                  -- N10 sha256 ueber kanonisches JSON
  created_at         INTEGER NOT NULL,                  -- ms-Epoch
  updated_at         INTEGER NOT NULL                   -- ms-Epoch, darf bei review_state-Update steigen
);

-- Primary access pattern: pro Workspace und Kind, nach Review-State filtern
-- (z.B. „alle pending-review knowledge_forms fuer Owner-UI").
CREATE INDEX IF NOT EXISTS idx_knowledge_ws_kind
  ON knowledge_forms (workspace_id, kind, review_state);

-- Glossary-Lookup: term ist nur fuer kind='glossary' belegt; partial index
-- erspart sich die NULL-Eintraege der anderen 11 Kinds.
CREATE INDEX IF NOT EXISTS idx_knowledge_term
  ON knowledge_forms (workspace_id, term)
  WHERE term IS NOT NULL;

-- Supersede-Kette: schneller Lookup, ob eine Row abgeloest wurde (eine andere
-- Row referenziert sie via supersedes_id).
CREATE INDEX IF NOT EXISTS idx_knowledge_supersedes
  ON knowledge_forms (supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- Hash-Lookup: Idempotenz-Pruefung bei Re-Extraction (gleicher Inhalt → gleicher
-- contentHash → kein doppeltes Insert).
CREATE INDEX IF NOT EXISTS idx_knowledge_hash
  ON knowledge_forms (content_hash);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Append-only-Light Trigger (N8)
--
-- Erlaubt:
--   - UPDATE auf review_state (Review-Flow: pending-review → approved/rejected)
--   - UPDATE auf supersedes_id (Supersede-Kette beim Re-Extract derselben Aussage)
--   - UPDATE auf updated_at (Begleit-Update zum Review)
-- Blockt:
--   - DELETE (use review_state='rejected' or supersedes_id)
--   - UPDATE auf id, kind, term, statement, content_hash (Kern-Identitaet
--     unveraenderlich — N1 + N10 Tamper-Evidenz).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS knowledge_forms_no_core_mutation
  BEFORE UPDATE OF id, kind, term, statement, content_hash
  ON knowledge_forms
BEGIN
  SELECT RAISE(ABORT, 'knowledge_forms core fields are immutable (N1/N10)');
END;

CREATE TRIGGER IF NOT EXISTS knowledge_forms_no_delete
  BEFORE DELETE ON knowledge_forms
BEGIN
  SELECT RAISE(ABORT, 'knowledge_forms is append-only — use review_state or supersedes_id');
END;
