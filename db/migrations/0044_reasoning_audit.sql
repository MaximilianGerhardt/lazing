-- Migration 0044 — Reasoning-Audit (Pattern 5 Traceability, 2026-05-01)
--
-- Addresses a critic finding: writeAudit (lib/audit/write.ts) logs only auth/identity.
-- There is NO reasoning audit for Sniper/Synthesis/Cross-Roast. Consequence: if
-- an LLM call hallucinates ("we decided X in Sub-Plan 03" although
-- not), there is no persisted trail that exposes it.
--
-- This table persists PER LLM call:
--   - claim_text: what the LLM claimed (compressed, max 4000 chars)
--   - source_chunks_json: which RAG chunks were in the prompt (sourceId array)
--   - prior_outputs_json: which Vn outputs/roast outputs were in the prompt
--   - prompt_hash: SHA-256 of the system+user prompt for reproducibility
--   - llm_provider/model: claude-opus-4-7, sonnet-4-6, haiku-4-5
--   - role: 'iterate-lead' | 'iterate-roaster-1' | 'cross-roast' | 'synthesis' | ...
--
-- Search pattern: on the user question "why did Sniper say that?" the server can
-- reproduce the exact same inputs by workstreamId+phase and
-- cross-check against the current LLM. This is the only robust hallucination
-- lever per the Stanford study 1/6.

CREATE TABLE IF NOT EXISTS reasoning_audit (
  id                   TEXT PRIMARY KEY,
  ts                   INTEGER NOT NULL,
  workspace_id         TEXT,
  workstream_id        TEXT,
  parent_ticket_id     TEXT,
  -- Phase in the FSM: V1, V2, V3, ..., synthesis, cross-roast, sniper-inject
  phase                TEXT NOT NULL,
  -- Role: iterate-lead | iterate-roaster-1 | cross-roast | synthesis | sub-spawn
  role                 TEXT NOT NULL,
  -- LLM identification
  llm_provider         TEXT NOT NULL,        -- 'anthropic' | 'tmux-claude'
  llm_model            TEXT NOT NULL,        -- claude-opus-4-7 etc.
  -- Hashes for reproducibility
  prompt_hash          TEXT NOT NULL,        -- SHA-256 system+user combined
  -- Compressed claim
  claim_text           TEXT NOT NULL,        -- max 4000, output excerpt
  -- Structured inputs (JSON)
  source_chunks_json   TEXT,                 -- ["file:abc","ticket:tck_x"]
  prior_outputs_json   TEXT,                 -- ["v1_text_hash","v2_text_hash"]
  user_corrections_json TEXT,                -- from the sniper inject
  -- Metrics
  cost_cents           INTEGER NOT NULL DEFAULT 0,
  duration_ms          INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER,
  -- Verification status: NULL = not verified, 'ok'|'drift'|'fabricated'
  verified_status      TEXT,
  verified_at          INTEGER,
  verified_note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_reasoning_audit_ts ON reasoning_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_audit_ws ON reasoning_audit (workstream_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_audit_ticket ON reasoning_audit (parent_ticket_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_audit_phase ON reasoning_audit (phase, ts DESC);
CREATE INDEX IF NOT EXISTS idx_reasoning_audit_unverified ON reasoning_audit (verified_status, ts DESC);
