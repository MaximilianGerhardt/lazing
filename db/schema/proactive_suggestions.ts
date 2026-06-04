/**
 * Drizzle schema for server-pre-generated proactive operator suggestions
 * (proactivity goal, 2026-06-02).
 *
 * A server-side watcher (hook in subchats/service.postMessage) generates,
 * on the arrival of an EXTERNAL message, ONE concrete next step for
 * the operator (claude-gated, workspace-isolated RAG, best-effort) and stores it
 * here. The main chat reads it PRE-generated instead of computing it client-side;
 * NEVER auto-send. dismissed_at marks "accepted/discarded". N2/N9 via
 * workspace_id. Append-light.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const proactiveSuggestions = sqliteTable(
  'proactive_suggestions',
  {
    /** ULID, prefix `PS-`. */
    id: text('id').primaryKey(),
    subchatId: text('subchat_id').notNull(),
    /** Scope (N9) + RAG-Isolation (N2). */
    workspaceId: text('workspace_id').notNull(),
    /** N1: VERBATIM operator-facing suggestion text, never truncated. */
    suggestion: text('suggestion').notNull(),
    /** Epoch ms. */
    createdAt: integer('created_at').notNull(),
    /** Epoch ms, NULL = active. Set on accept/discard. */
    dismissedAt: integer('dismissed_at'),
  },
  (table) => ({
    bySubchat: index('idx_proactive_suggestions_subchat').on(table.subchatId, table.createdAt),
    byWorkspace: index('idx_proactive_suggestions_workspace').on(table.workspaceId),
  }),
);

export type ProactiveSuggestionRow = typeof proactiveSuggestions.$inferSelect;
