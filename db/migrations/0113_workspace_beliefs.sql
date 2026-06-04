-- ============================================================
-- 0113_workspace_beliefs.sql — Self-Learning / WARUM-Engine · Stream A
--
-- Quelle: GOAL-lazyos-self-learning-why-engine +
--         docs/plans/2026-05-27_self-learning-and-flow-completion-plan.md (Stream A).
--
-- Kern-Befund: `workstream_decisions` (0071) ist heute WRITE-ONLY — das WARUM
-- (rationale) wird N8/N10-konform festgehalten, aber NIE zurückgelesen und nie
-- in spätere compose/plan-Schritte eingespeist. Diese Migration legt den
-- Lern-Store an, der aus dem Decision-Trail eine wiederverwendbare
-- Workspace-ReasoningBank macht.
--
-- Zwei additive Tabellen:
--
--   workspace_beliefs   — der eigentliche Lern-Store. Eine „Überzeugung" je
--                         Topic je Workspace. Append-only-GEIST: alte Beliefs
--                         werden NICHT gelöscht, sondern via supersedes_id
--                         abgelöst (→ N1 „nicht vergessen", volle Historie
--                         rekonstruierbar). belief + rationale VERBATIM (N1).
--                         content_hash für Tamper-Evidenz (N10).
--
--   decision_outcomes   — verknüpft eine getroffene Entscheidung (oder einen
--                         ganzen Workstream) mit ihrem späteren Ergebnis. Da
--                         `workstream_decisions` per Trigger append-only ist
--                         (UPDATE/DELETE verboten), MUSS das Outcome additiv in
--                         eine eigene Tabelle — kein In-Place-Update der
--                         Decision-Row. Speist den Post-Prozess-Abgleich (A5).
--
-- Substrat-Disziplin:
--   - N1:  belief / rationale / note werden VERBATIM persistiert (kein .slice).
--   - N4:  rein additiv — keine bestehende Tabelle geändert, kein Parallel-
--          Decisions-Modell. workspace_beliefs ist die Lese-/Lern-Schicht ÜBER
--          dem bestehenden Decision-Trail, nicht dessen Ersatz.
--   - N9:  workspace_id = ManifestCoord-Scope. Bewusst KEIN harter FK auf
--          workspaces (diese DB toleriert Orphan-Scope-Rows zur Laufzeit —
--          siehe db/client.ts FK-Notiz; analog 0111/0112).
--   - N10: content_hash (sha256 über kanonisches JSON) je belief-Row.
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX IF NOT EXISTS (Konvention 0111/0112).
-- Timestamps INTEGER (ms-Epoch, analog flow_*). IDs TEXT (ULID mit Prefix).
-- ============================================================

-- workspace_beliefs: der Lern-Store. Eine aktive Überzeugung je Topic;
-- abgelöste Beliefs bleiben als Historie erhalten (supersedes_id-Kette).
CREATE TABLE IF NOT EXISTS workspace_beliefs (
  id            TEXT    PRIMARY KEY NOT NULL,
  workspace_id  TEXT    NOT NULL,                 -- ManifestCoord-Scope (N9), kein harter FK
  topic         TEXT    NOT NULL,                 -- Themen-Schlüssel (Start: LIKE/exact-match-Recall)
  belief        TEXT    NOT NULL,                 -- die Überzeugung, VERBATIM (N1)
  rationale     TEXT    NOT NULL,                 -- das WARUM, VERBATIM (N1)
  source        TEXT    NOT NULL                  -- wer die Überzeugung gebildet hat
                CHECK (source IN ('user','ai')),
  supersedes_id TEXT,                             -- nullable: löst eine ältere belief ab (Historie bleibt)
  confidence    REAL,                             -- nullable: 0..1 Konfidenz (optional)
  content_hash  TEXT    NOT NULL,                 -- N10 Tamper-Evidenz (sha256 kanonisches JSON)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  -- Selbst-referenzieller Soft-FK auf die abgelöste Belief-Row.
  FOREIGN KEY (supersedes_id) REFERENCES workspace_beliefs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_beliefs_ws
  ON workspace_beliefs (workspace_id);

CREATE INDEX IF NOT EXISTS idx_workspace_beliefs_ws_topic
  ON workspace_beliefs (workspace_id, topic);

-- supersedes_id schnell auffindbar (Historie-Kette + „ist abgelöst?"-Lookup).
CREATE INDEX IF NOT EXISTS idx_workspace_beliefs_supersedes
  ON workspace_beliefs (supersedes_id);

-- decision_outcomes: verknüpft eine Entscheidung / einen Workstream mit ihrem
-- Ergebnis. Additiv, weil workstream_decisions append-only ist (0071-Trigger).
-- Mindestens eine von decision_id / workstream_id ist gesetzt (Soft-Constraint).
CREATE TABLE IF NOT EXISTS decision_outcomes (
  id             TEXT    PRIMARY KEY NOT NULL,
  workspace_id   TEXT    NOT NULL,                -- ManifestCoord-Scope (N9)
  decision_id    TEXT,                            -- Soft-FK auf workstream_decisions.id (nullable)
  workstream_id  TEXT,                            -- Soft-FK auf workstreams.id (nullable)
  outcome        TEXT    NOT NULL                 -- wie ist es ausgegangen
                 CHECK (outcome IN ('success','failure','partial','unknown')),
  note           TEXT,                            -- VERBATIM Begründung/Detail (N1), nullable
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_ws
  ON decision_outcomes (workspace_id);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_decision
  ON decision_outcomes (decision_id);

CREATE INDEX IF NOT EXISTS idx_decision_outcomes_workstream
  ON decision_outcomes (workstream_id);
