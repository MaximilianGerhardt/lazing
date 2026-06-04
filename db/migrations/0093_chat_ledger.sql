-- 0093: chat_ledger (BACKPORT-01 from Lazing-V2 · 2026-05-23)
--
-- Append-only chat ledger as the foundation for Gap 6 (conversation memory) +
-- N1 detail preservation. Every chat message is persisted VERBATIM and
-- unabridged. content_hash (sha256 over canonical-json) makes every row
-- tamper-evident (N10).
--
-- Source: lazing-wt/realtime-orchestrator-v2/packages/runtime/src/store/
--         migrations/014-chat-ledger.ts (Lazing-V2 slice DB).
--
-- Semantics (lazyos-stable adaptation):
--   - V2 extends workstreams (additive columns pending_prompt_id +
--     result_event_id). lazyos already has 0009_workstreams + 0018_streaming_
--     snapshots — we add rather than duplicate.
--   - This migration creates the NEW chat_ledger, which is N1-verbatim and
--     lives alongside the ephemeral streaming_snapshots table.
--   - workstream_id is nullable: chat can be started pre-workstream.
--   - parent_message_id allows branched conversations (Cross-Roast, Critic
--     loops, plan-in-plan).
--   - conversation_thread_id groups one logical conversation (even across
--     workstream boundaries — a workspace switch within a session).
--   - coord_key encodes ManifestCoord (at least workspace_id; if needed
--     org_id|workspace_id|workstream_id|surface tuple). Lint requirement: validate
--     before insert.
--
-- N1 enforcement:
--   - content_full is NOT NULL and NEVER truncated (an ESLint rule blocks
--     .slice/.substring on this field — see lib/chat/ledger.ts).
--   - content_hash MUST be passed by the caller on insert (canonical
--     json over the row payload, NOT incl. hash).
--
-- N10 enforcement:
--   - content_hash = sha256(canonicalJson({coord_key, role, content_full,
--     tool_calls_json, parent_message_id, conversation_thread_id, created_at})).
--   - The index idx_chat_ledger_hash allows an idempotency lookup (the service
--     detects a dup-insert before INSERT).
--
-- N9 enforcement:
--   - coord_key is validated against ManifestCoord before insert. The SQL layer
--     checks NOT NULL; semantic validation happens in lib/chat/ledger.ts.

CREATE TABLE IF NOT EXISTS chat_ledger (
  id                      TEXT PRIMARY KEY,                 -- ULID
  coord_key               TEXT NOT NULL,                    -- ManifestCoord encoded
  workstream_id           TEXT,                             -- nullable: pre-workstream chat
  role                    TEXT NOT NULL,                    -- user|assistant|tool|system|critic
  content_full            TEXT NOT NULL,                    -- N1: verbatim, NIE truncated
  content_hash            TEXT NOT NULL,                    -- N10: sha256(canonical-json)
  tool_calls_json         TEXT,                             -- nullable: tool-call array verbatim
  parent_message_id       TEXT,                             -- branched conversation parent
  conversation_thread_id  TEXT NOT NULL,                    -- group key
  created_at              INTEGER NOT NULL                  -- epoch ms
);

CREATE INDEX IF NOT EXISTS idx_chat_ledger_coord
  ON chat_ledger (coord_key);

CREATE INDEX IF NOT EXISTS idx_chat_ledger_thread
  ON chat_ledger (conversation_thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_chat_ledger_workstream
  ON chat_ledger (workstream_id)
  WHERE workstream_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_ledger_hash
  ON chat_ledger (content_hash);

CREATE INDEX IF NOT EXISTS idx_chat_ledger_parent
  ON chat_ledger (parent_message_id)
  WHERE parent_message_id IS NOT NULL;
