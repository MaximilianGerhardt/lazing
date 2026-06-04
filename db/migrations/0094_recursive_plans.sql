-- 0094: workstream_plan_steps + workstream_plan_critics (BACKPORT-03 from Lazing-V2 · 2026-05-23)
--
-- Recursive plan-in-plan + critic-loop FSM substrate.
--
-- Source: lazing-wt/realtime-orchestrator-v2/packages/runtime/src/store/
--         migrations/011-recursive-plans.ts (Lazing-V2 slice C).
--
-- Lazyos-stable adaptation (delta from the V2 source):
--   - lazyos-stable has NO existing workstream_plan_steps table —
--     V2 extends it (ALTER TABLE ADD COLUMN depth), we CREATE it new here
--     with `depth` from the start.
--   - workstream_plan_critics 1:1 like V2 (additive helper table, N4).
--
-- What it does:
--
--   (a) workstream_plan_steps — the persisted form of a ProposedPlan.
--       Each step belongs to a workstream (workstream_id NOT NULL FK),
--       carries depth (0 = root, 1..3 = subplan recursion). MAX_SUBPLAN_DEPTH=3
--       is enforced in code (lib/critic-loop/critic-loop.ts) — SQLite ALTER
--       allows no after-the-fact CHECK, hence defense-in-depth in TS.
--
--   (b) workstream_plan_critics — one row per critic-round emission.
--       INV-16 (max 2 fix-iter) means max 3 rows per plan_step_id:
--       iter=0 (initial critic) + iter=1 + iter=2.
--       INV-19 — coord_key mirrors the coder lane (same ManifestCoord scope).
--       superseded_at: soft-mark, when a later iteration replaces the
--         round — N8 (trace preserves the full critic history).
--
-- N1: comments_json is persisted verbatim (no .slice in insert paths).
-- N6: FSM transitions are deterministic (lib/critic-loop/critic-loop.ts).
-- N8: every critic-round insert = one audit row (no DELETE; supersede instead of deleting).
-- N9: coord_key is validated against ManifestCoord before insert.
-- N10: content_hash = sha256(canonicalJson(row sans hash)).

-- ─── workstream_plan_steps ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workstream_plan_steps (
  id                  TEXT PRIMARY KEY,             -- ULID
  workstream_id       TEXT NOT NULL,                -- FK → workstreams.id (logical)
  plan_id             TEXT NOT NULL,                -- groups steps of one ProposedPlan
  parent_step_id      TEXT,                         -- nullable: subplan parent step
  step_index          INTEGER NOT NULL,             -- 1-based source order
  title               TEXT NOT NULL,                -- N1: verbatim
  rationale           TEXT NOT NULL,                -- N1: verbatim
  subagent_role       TEXT,                         -- architect|coder|tester|reviewer
  target_files_json   TEXT,                         -- JSON array of 1-3 path hints
  expected_artifacts_json TEXT,                     -- JSON array of 1-3 artifact keywords
  depth               INTEGER NOT NULL DEFAULT 0,   -- 0..3 (cap enforced in code)
  coord_key           TEXT NOT NULL,                -- N9: ManifestCoord encoded
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|active|done|failed|cancelled
  content_hash        TEXT NOT NULL,                -- N10: sha256(canonical-json sans hash)
  created_at          INTEGER NOT NULL,             -- epoch ms
  updated_at          INTEGER NOT NULL              -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_plan_steps_ws
  ON workstream_plan_steps (workstream_id, depth, step_index);

CREATE INDEX IF NOT EXISTS idx_plan_steps_plan
  ON workstream_plan_steps (plan_id, step_index);

CREATE INDEX IF NOT EXISTS idx_plan_steps_parent
  ON workstream_plan_steps (parent_step_id)
  WHERE parent_step_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plan_steps_coord
  ON workstream_plan_steps (coord_key);

CREATE INDEX IF NOT EXISTS idx_plan_steps_hash
  ON workstream_plan_steps (content_hash);

-- ─── workstream_plan_critics ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workstream_plan_critics (
  id                  TEXT PRIMARY KEY,             -- ULID
  plan_step_id        TEXT NOT NULL                 -- FK → workstream_plan_steps.id
                        REFERENCES workstream_plan_steps(id) ON DELETE CASCADE,
  iteration           INTEGER NOT NULL DEFAULT 0,   -- 0 = first critic round, 1+2 = fix-iters (INV-16 cap)
  verdict             TEXT NOT NULL,                -- pass|conditional|fail|superseded
  comments_json       TEXT NOT NULL DEFAULT '[]',   -- N1: ReadonlyArray<{role,text,severity}> verbatim
  critic_role         TEXT NOT NULL DEFAULT 'critic', -- critic|cross-roast|operator
  coord_key           TEXT NOT NULL,                -- INV-19: same as coder-lane coord
  workstream_id       TEXT,                         -- nullable: pre-workstream critics
  content_hash        TEXT NOT NULL,                -- N10: sha256(canonical-json sans hash)
  superseded_at       INTEGER,                      -- soft-mark when a later iter replaces
  created_at          INTEGER NOT NULL              -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_plan_critics_step
  ON workstream_plan_critics (plan_step_id, iteration);

CREATE INDEX IF NOT EXISTS idx_plan_critics_verdict
  ON workstream_plan_critics (verdict);

CREATE INDEX IF NOT EXISTS idx_plan_critics_coord
  ON workstream_plan_critics (coord_key);
