/**
 * Drizzle schema for the `chat_ledger` table (BACKPORT-01 · 2026-05-23).
 *
 * Append-only chat ledger as the N1-verbatim foundation for Gap 6
 * (conversation memory). Every chat message is persisted unabridged.
 * content_hash makes every row tamper-evident (N10).
 *
 * Source: Lazing-V2 packages/runtime/src/store/migrations/014-chat-ledger.ts.
 *
 * Note: the N1 lint rule forbids .slice/.substring on content_full +
 * tool_calls_json. The service layer (lib/chat/ledger.ts) is the ONLY
 * insert path — UI/API must NOT INSERT directly.
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const chatLedger = sqliteTable(
  'chat_ledger',
  {
    /** ULID, prefix `CL-`. */
    id: text('id').primaryKey(),
    /** ManifestCoord encoded — at least workspace_id. */
    coordKey: text('coord_key').notNull(),
    /** Nullable: chat can be started pre-workstream. */
    workstreamId: text('workstream_id'),
    /** Closed enum: user | assistant | tool | system | critic. */
    role: text('role').notNull(),
    /** N1: VERBATIM, NIE truncated. */
    contentFull: text('content_full').notNull(),
    /** N10: sha256(canonicalJson(payload-without-hash)). */
    contentHash: text('content_hash').notNull(),
    /** Nullable: JSON array of tool-call objects, verbatim. */
    toolCallsJson: text('tool_calls_json'),
    /** Branched conversations (Cross-Roast, Critic loops). */
    parentMessageId: text('parent_message_id'),
    /** Group key for one logical conversation. */
    conversationThreadId: text('conversation_thread_id').notNull(),
    /** Epoch ms. */
    createdAt: integer('created_at').notNull(),
  },
  (table) => ({
    byCoord: index('idx_chat_ledger_coord').on(table.coordKey),
    byThread: index('idx_chat_ledger_thread').on(
      table.conversationThreadId,
      sql`${table.createdAt}`,
    ),
    byWorkstream: index('idx_chat_ledger_workstream').on(table.workstreamId),
    byHash: index('idx_chat_ledger_hash').on(table.contentHash),
    byParent: index('idx_chat_ledger_parent').on(table.parentMessageId),
  }),
);

export type ChatLedgerRow = typeof chatLedger.$inferSelect;
export type ChatLedgerInsert = typeof chatLedger.$inferInsert;

/** Closed role enum — the only set that may be written into role=. */
export const CHAT_LEDGER_ROLES = [
  'user',
  'assistant',
  'tool',
  'system',
  'critic',
] as const;
export type ChatLedgerRole = (typeof CHAT_LEDGER_ROLES)[number];
