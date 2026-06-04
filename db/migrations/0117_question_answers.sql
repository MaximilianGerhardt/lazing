-- 0117_question_answers.sql · 2026-05-29
--
-- PURPOSE (Phase 1 Track AB · finding B):
--   Answers to open-questions are TODAY sent as a plain "Question:.../Answer:..."
--   text block (lib/chat/ChatShell.tsx::buildQAReply, ~L.195-207) into the
--   normal chat stream. This loses the following bindings:
--     - workstreamId  · (workstream/run context)
--     - flowRunId     · (which flow run waits for this answer?)
--     - planId        · (which plan node asked the question?)
--     - questionSetId · (bundle of questions answered together)
--     - questionId    · (the concrete question)
--   Re-render after reload shows the question as open again, because no
--   structured trace exists.
--
-- THIS FIX (additive, fail-soft, N1+N8+N10):
--   A dedicated table `question_answers` with the full envelope.
--   `answer` is TEXT VERBATIM (N1 — no .slice/.substring in the writer).
--   `content_hash` is the N10 tamper evidence over the canonically serialized
--   envelope (sha256). The UNIQUE constraint on `content_hash` makes re-posts
--   of the same envelope idempotent (acceptance test "idempotent second post").
--   Additionally idempotency-stable over (`source_turn_id`, `question_id`) —
--   an identical repeat from the same ChatShell turn does not lead to
--   a second row (second idx, OR IGNORE).
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   - NO UPDATE on existing tables.
--   - NO trigger.
--   - NO FK on workstreams/flow_runs/plans — these fields are soft
--     (all optional, because an open-question can also stand in free-chat without an active
--     workstream; cf. the dismiss-route "no-workstream" path).
--   - NO read side-effect (hydration comes as a separate GET endpoint).
--
-- FAIL-SOFT:
--   `IF NOT EXISTS` for the table + indexes — idempotent on re-migrate.

CREATE TABLE IF NOT EXISTS question_answers (
  id TEXT PRIMARY KEY,
  -- Required. The subject gate hangs on workspaceId.
  workspace_id TEXT NOT NULL,
  -- Optional (free-chat without an active workstream possible).
  workstream_id TEXT,
  -- Optional. Flow-run context for resumption.
  flow_run_id TEXT,
  -- Optional. Plan node that asked the question.
  plan_id TEXT,
  -- Optional. Bundle ID when multiple questions were asked together.
  question_set_id TEXT,
  -- Required. The concrete question ID (PlanQuestion.id / OpenQuestion.id).
  question_id TEXT NOT NULL,
  -- Required. VERBATIM (N1) — no .slice/.substring in the writer.
  answer TEXT NOT NULL,
  -- Required. ChatShell-internal turn (HistoryItem.id) under which the answer
  -- was sent. Plus question_id this yields the idempotency key
  -- for re-posts from the same turn (e.g. double-click, React StrictMode).
  source_turn_id TEXT NOT NULL,
  -- Optional. Surface ID if the answer went over a specific surface.
  surface_id TEXT,
  -- Standard ts. Epoch-ms, default 0 for test determinism (analogous to 0115).
  created_at INTEGER NOT NULL DEFAULT 0,
  -- N10 tamper evidence. sha256 over the canonically serialized envelope.
  content_hash TEXT NOT NULL
);

-- Lookup by workspace + (optional) workstream — for hydration.
CREATE INDEX IF NOT EXISTS idx_question_answers_ws_workstream
  ON question_answers (workspace_id, workstream_id);

-- Lookup by question ID — for "is this concrete question already answered?".
CREATE INDEX IF NOT EXISTS idx_question_answers_question_id
  ON question_answers (question_id);

-- Idempotency via the envelope hash (N10). UNIQUE → INSERT OR IGNORE silently
-- suppresses the second identical post.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_question_answers_content_hash
  ON question_answers (content_hash);

-- Additional idempotency key: (source_turn_id, question_id). The ChatShell
-- turn is client-generated; if the same answer is emitted twice from the same turn,
-- the second post should be silently discarded, even if
-- the content_hash were to differ for some reason
-- (defense-in-depth against client bugs).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_question_answers_turn_question
  ON question_answers (source_turn_id, question_id);
