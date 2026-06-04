-- lazyOS Sprint 2 · Stream A' — Claude CLI session persistence
--
-- Per workspace we keep the last Claude-Code CLI session UUID. The agent server
-- uses `claude --resume <session_id>` to preserve context between chats —
-- this replaces the original "persistent tmux + interactive claude" concept
-- with the more robust `--print --output-format=stream-json` pipeline, but keeps
-- the "per-workspace context persists" invariant from the memory pin of 2026-04-24.
--
-- Idempotent: can run multiple times.

CREATE TABLE IF NOT EXISTS claude_sessions (
  workspace_id     TEXT PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,                -- UUID der Claude-Code Session
  claude_version   TEXT,                         -- "2.1.119 (Claude Code)" at creation time
  last_prompt_at   INTEGER NOT NULL,             -- ms since epoch
  turn_count       INTEGER NOT NULL DEFAULT 0,   -- inkrementiert pro erfolgreicher /chat-Request
  last_result      TEXT,                         -- 'success' | 'error' | 'aborted' | 'too_many_turns'
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_claude_sessions_last_prompt ON claude_sessions (last_prompt_at DESC);
