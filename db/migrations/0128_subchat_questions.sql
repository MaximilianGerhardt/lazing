-- 0128_subchat_questions.sql — Question-Spinning in Sub-/Gruppen-Chats (2026-06-03)
-- Design: docs/plans/2026-06-03_group-chat-question-spinning-design.md §3.
-- Idempotent (IF NOT EXISTS). N9: workspace_id auf jeder Row. Append-only.

CREATE TABLE IF NOT EXISTS subchat_questions (
  id            TEXT PRIMARY KEY,
  subchat_id    TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  author_kind   TEXT NOT NULL,            -- 'internal' | 'external' | 'ai'
  author_id     TEXT,
  author_name   TEXT,
  text          TEXT NOT NULL,            -- N1 verbatim
  seq           INTEGER NOT NULL,         -- monoton pro subchat_id ("aufeinanderfolgend")
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'resolved'
  resolved_at   INTEGER,
  resolved_by   TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subchat_questions_subchat ON subchat_questions (subchat_id, seq);
CREATE INDEX IF NOT EXISTS idx_subchat_questions_open    ON subchat_questions (subchat_id, status);
CREATE INDEX IF NOT EXISTS idx_subchat_questions_ws      ON subchat_questions (workspace_id);

CREATE TABLE IF NOT EXISTS subchat_question_options (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL,
  subchat_id    TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  label         TEXT NOT NULL,            -- N1 verbatim
  added_by_kind TEXT NOT NULL,            -- 'internal' | 'external' | 'ai'
  added_by_id   TEXT,
  seq           INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scq_options_question ON subchat_question_options (question_id, seq);
CREATE INDEX IF NOT EXISTS idx_scq_options_subchat  ON subchat_question_options (subchat_id);

CREATE TABLE IF NOT EXISTS subchat_question_answers (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL,
  subchat_id    TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  answerer_kind TEXT NOT NULL,            -- 'internal' | 'external' | 'ai'
  answerer_id   TEXT,
  answerer_name TEXT,
  option_id     TEXT,                     -- gesetzt wenn via Option
  free_text     TEXT,                     -- gesetzt wenn Freitext (N1 verbatim)
  ingested      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scq_answers_question ON subchat_question_answers (question_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scq_answers_answerer ON subchat_question_answers (question_id, answerer_kind, answerer_id);
CREATE INDEX IF NOT EXISTS idx_scq_answers_ingest   ON subchat_question_answers (ingested);
