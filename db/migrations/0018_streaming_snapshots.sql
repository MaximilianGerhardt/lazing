-- 0018: streaming_snapshots (Streaming-Recovery V2 · 2026-04-27)
--
-- Ephemeral table for the live partial state of a streaming
-- assistant response. UPSERT semantics: every 1500 ms from the agent server
-- during `sendPrompt`, a final flush before `chat_message_completed`,
-- DELETE of the row in the completed handler (no audit claim — reload
-- recovery only). This removes compaction, the sensitivity race and
-- append-only-log bloat.
--
-- Schema:
--   pending_prompt_id   PK, identical to the `pendingPromptId` from
--                        chat_message_sent — by which the history joins
--                        without a secondary key.
--   workspace_id         index key for the history endpoint
--                        (`/api/chat/history/[workspaceId]`).
--   partial_content      token-stream output accumulated so far.
--   tool_state           JSON string or NULL: active tool call
--                        ({name, status:'pending'|'done'}). Is
--                        cleaned up as soon as tool_result arrives.
--   in_code_block        0/1 (SQLite has no bool). The writer's backtick
--                        counter — an odd ``` ⇒ inside a code block.
--   started_at           first UPSERT — for "when did the stream start".
--   updated_at           last UPSERT — heuristic for state='aborted'
--                        (now - updated_at >= 10000 ms).
--
-- State heuristic in the history endpoint:
--   state = 'streaming' if now - updated_at < 10000 ms
--   state = 'aborted'   otherwise (the writer wrote nothing for >10s)
--
-- Lifecycle:
--   - INSERT/UPDATE every 1500 ms in the snapshot writer (server/workspace-session.ts).
--   - DELETE in the completed handler (same path, same TX).
--   - A server restart leaves rows behind — they are delivered as 'aborted' on the next
--     history read (the 10s heuristic takes effect immediately).

CREATE TABLE IF NOT EXISTS streaming_snapshots (
  pending_prompt_id  TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  partial_content    TEXT NOT NULL DEFAULT '',
  tool_state         TEXT,
  in_code_block      INTEGER NOT NULL DEFAULT 0,
  started_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_streaming_snapshots_ws_updated
  ON streaming_snapshots (workspace_id, updated_at DESC);
