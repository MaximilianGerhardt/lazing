-- ============================================================
-- 0099_sops.sql — SOP-Framework (Standard Operating Procedures)
--
-- Datum:  2026-05-24
-- Autor:  Claude Code (SAR-2 SOP-Framework sprint)
--
-- Tables created:
--   sops           — reusable plan-skeleton templates (global or workspace-scoped)
--   sop_steps      — ordered steps within a SOP (N1: full prompt_template, no truncation)
--
-- Binding columns added to routines:
--   sop_id                 — optional FK to sops (NULL = shell-only routine, backward-compat)
--   goal_prompt            — free-text goal that gets threaded through the SOP steps
--   skill_bindings_json    — JSON map { stepIndex: skillId } overrides per step
--   mcp_tool_allowlist_json — JSON array of allowed MCP tool names for this routine run
--   action_kind            — 'shell' (default, existing behaviour) | 'plan-dispatch' (new bridge)
--
-- N1:  step_prompt_template is TEXT, never sliced — lint rule in eslint guards ledger fields;
--      same discipline applies here.
-- N10: content_hash = sha256 over canonical JSON (written by application layer, not SQL).
-- N8:  sops are append-preferred; archive_at soft-deletes; no destructive DELETE in registry.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS everywhere.
--             ALTER TABLE ADD COLUMN uses per-statement fallback (duplicate-column-safe).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. sops — plan-skeleton templates
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sops (
  id              TEXT     PRIMARY KEY,                    -- ULID with SOP- prefix
  name            TEXT     NOT NULL,
  description     TEXT,
  -- NULL = global/template SOP (visible to all workspaces)
  -- non-NULL = workspace-scoped SOP (private to that workspace)
  workspace_id    TEXT,
  version         INTEGER  NOT NULL DEFAULT 1,
  -- 1 = built-in seed (read-only for users); 0 = user-created
  built_in        INTEGER  NOT NULL DEFAULT 0
                           CHECK (built_in IN (0, 1)),
  -- soft-delete timestamp (NULL = active)
  archived_at     INTEGER,
  -- N10: sha256 over canonical JSON of this row (sans content_hash itself)
  -- Computed by application layer (lib/sop/registry.ts); bootstrap sentinel
  -- for seed rows, overwritten on first mutation.
  content_hash    TEXT     NOT NULL DEFAULT '',
  created_at      INTEGER  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sops_workspace
  ON sops (workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sops_global
  ON sops (built_in, archived_at)
  WHERE workspace_id IS NULL;

-- ─────────────────────────────────────────────────────────────
-- 2. sop_steps — ordered steps within a SOP
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sop_steps (
  id                      TEXT     PRIMARY KEY,            -- ULID with SOPS- prefix
  sop_id                  TEXT     NOT NULL
                          REFERENCES sops(id) ON DELETE CASCADE,
  -- 0-based insertion order; ORDER BY step_index for deterministic expansion
  step_index              INTEGER  NOT NULL,
  title                   TEXT     NOT NULL,
  -- N1: FULL prompt template text — NEVER sliced, NEVER truncated.
  -- ESLint guard (N1-eslint-guard) covers ledger fields; same discipline here.
  step_prompt_template    TEXT     NOT NULL,
  -- Closed enum matching orchestrate-plan.ts PlanSubagentRole:
  --   architect | coder | tester | reviewer | researcher | scribe
  -- NULL = no role preference (caller picks default).
  subagent_role           TEXT,
  -- JSON array of skill IDs (strings) — optional per-step skill overrides.
  -- e.g. ["skill:researcher", "skill:rag-retriever"]
  required_skills_json    TEXT,
  -- JSON array of MCP tool names allowed for this specific step.
  -- e.g. ["mcp__ruv-swarm__task_orchestrate", "mcp__flow-nexus__neural_predict"]
  mcp_tool_allowlist_json TEXT,
  -- 1 = step may be skipped if upstream data is unavailable; 0 = required
  optional                INTEGER  NOT NULL DEFAULT 0
                          CHECK (optional IN (0, 1)),
  UNIQUE(sop_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_sop_steps_sop
  ON sop_steps (sop_id, step_index);

-- ─────────────────────────────────────────────────────────────
-- 3. Binding columns on routines
--    Each ALTER TABLE ADD COLUMN is individually idempotent via the
--    per-statement duplicate-column fallback in db/client.ts.
-- ─────────────────────────────────────────────────────────────

-- FK to sops (NULL = shell-only routine — backward-compatible default)
ALTER TABLE routines ADD COLUMN sop_id TEXT;

-- Free-text goal threaded through SOP steps at dispatch time
ALTER TABLE routines ADD COLUMN goal_prompt TEXT;

-- JSON map: { "<stepIndex>": "<skillId>" } — per-step skill overrides
ALTER TABLE routines ADD COLUMN skill_bindings_json TEXT;

-- JSON array of MCP tool names — routine-level allow-list override
ALTER TABLE routines ADD COLUMN mcp_tool_allowlist_json TEXT;

-- 'shell' preserves all existing behaviour (default).
-- 'plan-dispatch' triggers the SOP→PlanNode bridge (Wave 2 / SAR-3).
ALTER TABLE routines ADD COLUMN action_kind TEXT NOT NULL DEFAULT 'shell';

-- Index for fast look-up of plan-dispatch routines (SAR-3 scheduler)
CREATE INDEX IF NOT EXISTS idx_routines_action_kind
  ON routines (action_kind)
  WHERE action_kind != 'shell';

-- ─────────────────────────────────────────────────────────────
-- 4. Generic built-in seed SOPs (built_in=1)
--    3 canonical workflow patterns, clearly marked as generic templates.
--    Not hardcoded to any specific platform, client or toolchain.
--    content_hash = bootstrap sentinel (application layer overwrites on first
--    mutation — same pattern as 0098_permission.sql bootstrap row).
-- ─────────────────────────────────────────────────────────────

-- SOP 1: research-synthesize-draft-review
INSERT OR IGNORE INTO sops (id, name, description, workspace_id, version, built_in, content_hash, created_at)
VALUES (
  'SOP-BUILTIN-RESEARCH-SYNTH-01',
  'Research → Synthesize → Draft → Review',
  'Generic 4-step research pipeline. Researcher collects sources, Scribe synthesizes into a draft, Reviewer critiques, final revision pass. Suitable for any research-heavy deliverable.',
  NULL,
  1,
  1,
  'bootstrap:0099:SOP-BUILTIN-RESEARCH-SYNTH-01',
  strftime('%s', 'now') * 1000
);

INSERT OR IGNORE INTO sop_steps (id, sop_id, step_index, title, step_prompt_template, subagent_role, required_skills_json, mcp_tool_allowlist_json, optional)
VALUES
  ('SOPS-RS-01', 'SOP-BUILTIN-RESEARCH-SYNTH-01', 0,
   'Research: Collect sources and evidence',
   'You are a Researcher agent. Your goal is: {{goal_prompt}}

Collect all relevant sources, data points, prior art and evidence related to the goal. Output a structured list of findings with source references. Do NOT summarise prematurely — preserve full detail (N1). If any source is inaccessible, note it explicitly rather than omitting it.',
   'researcher',
   '["skill:researcher"]',
   NULL,
   0),

  ('SOPS-RS-02', 'SOP-BUILTIN-RESEARCH-SYNTH-01', 1,
   'Synthesize: Distil findings into a coherent structure',
   'You are a Scribe agent. Your input is the research findings from the previous step.

Goal context: {{goal_prompt}}

Synthesize the raw findings into a coherent, logically ordered structure. Preserve verbatim quotes and data points (N1). Produce a structured outline or document that the Reviewer can evaluate. Do NOT condense or paraphrase source data — keep all detail.',
   'scribe',
   '["skill:scribe"]',
   NULL,
   0),

  ('SOPS-RS-03', 'SOP-BUILTIN-RESEARCH-SYNTH-01', 2,
   'Draft: Produce the deliverable document',
   'You are a Coder/Writer agent. Your input is the synthesized structure from the previous step.

Goal context: {{goal_prompt}}

Produce the final draft deliverable. Write in the appropriate format for the goal (report, spec, code, analysis). Every claim must reference a source from the research step. No fabrication.',
   'coder',
   NULL,
   NULL,
   0),

  ('SOPS-RS-04', 'SOP-BUILTIN-RESEARCH-SYNTH-01', 3,
   'Review: Critique and identify gaps',
   'You are a Reviewer agent. Your input is the draft from the previous step.

Goal context: {{goal_prompt}}

Apply a structured critique: (1) factual accuracy, (2) completeness vs. research findings, (3) logical consistency, (4) missing evidence. Output a numbered list of findings, severity (MAJOR/MINOR/NOTE), and for each MAJOR finding a concrete remediation suggestion.',
   'reviewer',
   NULL,
   NULL,
   0);

-- SOP 2: content-pipeline-generic
INSERT OR IGNORE INTO sops (id, name, description, workspace_id, version, built_in, content_hash, created_at)
VALUES (
  'SOP-BUILTIN-CONTENT-PIPE-01',
  'Content Pipeline (Generic)',
  'Generic 4-step content production pipeline: Research → Script/Outline Draft → Editorial Review → Production Plan. Applicable to any content type (article, report, briefing, video script). Not tied to any specific platform.',
  NULL,
  1,
  1,
  'bootstrap:0099:SOP-BUILTIN-CONTENT-PIPE-01',
  strftime('%s', 'now') * 1000
);

INSERT OR IGNORE INTO sop_steps (id, sop_id, step_index, title, step_prompt_template, subagent_role, required_skills_json, mcp_tool_allowlist_json, optional)
VALUES
  ('SOPS-CP-01', 'SOP-BUILTIN-CONTENT-PIPE-01', 0,
   'Research: Gather topic background and reference material',
   'You are a Researcher agent. Goal: {{goal_prompt}}

Gather all relevant background information for this content piece: existing treatments of the topic, key facts, statistics, expert positions, and audience context. Output a structured brief with: (a) key messages to communicate, (b) supporting evidence, (c) tone/audience notes. Full detail preserved (N1).',
   'researcher',
   '["skill:researcher"]',
   NULL,
   0),

  ('SOPS-CP-02', 'SOP-BUILTIN-CONTENT-PIPE-01', 1,
   'Draft: Write the script or content outline',
   'You are a Coder/Writer agent. Your input is the research brief from the previous step.

Goal: {{goal_prompt}}

Produce the full content draft or script. Structure it clearly with headers/sections. Every factual claim maps to a source from the research brief. Preserve specificity — no vague generalisations where concrete facts are available.',
   'coder',
   NULL,
   NULL,
   0),

  ('SOPS-CP-03', 'SOP-BUILTIN-CONTENT-PIPE-01', 2,
   'Review: Editorial check for accuracy, clarity and completeness',
   'You are a Reviewer agent. Your input is the draft from the previous step.

Goal: {{goal_prompt}}

Perform an editorial review: (1) factual accuracy vs. research brief, (2) structural clarity and logical flow, (3) tone alignment with audience, (4) any missing key messages identified in research. Output a prioritised list of edits (REQUIRED / SUGGESTED / OPTIONAL).',
   'reviewer',
   NULL,
   NULL,
   0),

  ('SOPS-CP-04', 'SOP-BUILTIN-CONTENT-PIPE-01', 3,
   'Production Plan: Specify assets, schedule and distribution steps',
   'You are an Architect agent. Your input is the approved draft and editorial notes.

Goal: {{goal_prompt}}

Produce a concrete production plan: (1) list of assets required (text, visuals, audio, etc.), (2) suggested production sequence with dependencies, (3) distribution channel checklist, (4) any technical requirements per channel. Keep generic — do NOT assume specific tooling unless stated in goal_prompt.',
   'architect',
   NULL,
   NULL,
   1),

  ('SOPS-CP-05', 'SOP-BUILTIN-CONTENT-PIPE-01', 4, -- optional final-cut
   'Final Cut: Integrate edits and produce final version',
   'You are a Coder/Writer agent. Your inputs are the original draft and the editorial review from the previous steps.

Goal: {{goal_prompt}}

Integrate all REQUIRED edits from the review. Apply SUGGESTED edits where they improve the piece without contradicting the goal. Produce the final, publication-ready version. Mark each change with the review finding it addresses.',
   'coder',
   NULL,
   NULL,
   1);

-- SOP 3: bugfix-triage
INSERT OR IGNORE INTO sops (id, name, description, workspace_id, version, built_in, content_hash, created_at)
VALUES (
  'SOP-BUILTIN-BUGFIX-TRIAGE-01',
  'Bug-Fix Triage Pipeline',
  'Generic 4-step bug-fix workflow: Researcher triages and reproduces, Coder implements fix, Tester verifies, Reviewer approves. Maps directly onto the plan-first bug-fix template steps.',
  NULL,
  1,
  1,
  'bootstrap:0099:SOP-BUILTIN-BUGFIX-TRIAGE-01',
  strftime('%s', 'now') * 1000
);

INSERT OR IGNORE INTO sop_steps (id, sop_id, step_index, title, step_prompt_template, subagent_role, required_skills_json, mcp_tool_allowlist_json, optional)
VALUES
  ('SOPS-BF-01', 'SOP-BUILTIN-BUGFIX-TRIAGE-01', 0,
   'Triage: Reproduce and locate the defect',
   'You are a Researcher agent. Bug report / goal: {{goal_prompt}}

Triage the reported defect: (1) reproduce it with a minimal test case or repro steps, (2) locate the root-cause code path (file + line), (3) classify severity (P0–P3) and impact surface, (4) rule out environmental issues vs. code defects. Output a structured triage report with all findings verbatim (N1). Do NOT attempt a fix yet.',
   'researcher',
   '["skill:researcher"]',
   NULL,
   0),

  ('SOPS-BF-02', 'SOP-BUILTIN-BUGFIX-TRIAGE-01', 1,
   'Fix: Implement the minimal targeted code change',
   'You are a Coder agent. Your input is the triage report from the previous step.

Goal: {{goal_prompt}}

Implement the minimal code change that resolves the root cause identified in triage. Prefer surgical fixes over refactors (unless the triage report recommends a broader change). Output the diff with an explanation of each change keyed to the triage findings.',
   'coder',
   NULL,
   NULL,
   0),

  ('SOPS-BF-03', 'SOP-BUILTIN-BUGFIX-TRIAGE-01', 2,
   'Test: Verify the fix and check for regressions',
   'You are a Tester agent. Your inputs are the triage report and the fix diff from previous steps.

Goal: {{goal_prompt}}

Verify the fix: (1) run or describe the reproduction test case — does it now pass? (2) run the relevant test suite and confirm no regressions, (3) for each change in the diff, identify the closest existing test that covers it (or note the coverage gap). Output a test report with pass/fail for each check.',
   'tester',
   NULL,
   NULL,
   0),

  ('SOPS-BF-04', 'SOP-BUILTIN-BUGFIX-TRIAGE-01', 3,
   'Review: Approve fix or raise concerns',
   'You are a Reviewer agent. Your inputs are the triage report, fix diff and test report from previous steps.

Goal: {{goal_prompt}}

Perform a final code review: (1) does the fix address the root cause without introducing new risk? (2) is the change minimal and readable? (3) are there any edge cases the triage or tests missed? Output APPROVED or BLOCKED with specific, actionable findings. BLOCKED requires a concrete remediation for each blocker.',
   'reviewer',
   NULL,
   NULL,
   0);
