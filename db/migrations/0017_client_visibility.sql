-- 0017: client_visibility + chat_message_legacy_unique (Phase MS · 2026-04-26)
--
-- (1) client_visibility
--   Replaces the in-memory map in lib/chat/visibility-tracker.ts. Cross-process
--   visibility state between Next.js (markClientVisible/markClientHidden via
--   /api/chat/visibility) and agent-server (isAnyClientVisible in
--   the onChatMessageCompleted push trigger). Map-only was a process singleton —
--   the push ALWAYS fired, because the trigger in the agent-server process had no
--   write access to the Next.js map.
--
--   Schema: workspace_id PK, last_seen_ms NOT NULL.
--   isAnyClientVisible: SELECT WHERE last_seen_ms > now - 30000.
--   markClientHidden: DELETE row.
--
-- (2) idx_chat_msg_legacy_unique
--   Prevents an MS.6 migration double-import on a race between 2 tabs (both
--   see an empty pre-check, both insert → double). Unique partial index
--   on (segment_id, json_extract(payload, '$.legacyId')) WHERE entityType=
--   'chat_message' AND legacyId IS NOT NULL. Insert with conflict → SQLITE_
--   CONSTRAINT, the caller swallows it.

CREATE TABLE IF NOT EXISTS client_visibility (
  workspace_id TEXT PRIMARY KEY,
  last_seen_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_client_visibility_last_seen
  ON client_visibility (last_seen_ms);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_msg_legacy_unique
  ON events (segment_id, json_extract(payload, '$.legacyId'))
  WHERE entity_type = 'chat_message' AND json_extract(payload, '$.legacyId') IS NOT NULL;
