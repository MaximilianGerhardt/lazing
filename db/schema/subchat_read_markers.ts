/**
 * Drizzle schema for sub-chat read markers (gathering-intelligence goal, P2).
 *
 * One marker per (sub-chat, user) with the timestamp of the last read
 * message. Basis for the unread badge in the main chat + sub-chat list.
 * Workspace-scoped via subchat_id (the sub-chat carries the workspace_id, N2/N9).
 * Idempotent upsert on the composite PK (subchat_id, user_id).
 */

import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const subchatReadMarkers = sqliteTable(
  'subchat_read_markers',
  {
    /** FK-artig auf subchats.id (kein harter FK — Single-User-MVP). */
    subchatId: text('subchat_id').notNull(),
    /** Lesender interner User. */
    userId: text('user_id').notNull(),
    /** Epoch ms der zuletzt gelesenen Nachricht (createdAt-Cutoff). */
    lastReadTs: integer('last_read_ts').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.subchatId, table.userId] }),
    byUser: index('idx_subchat_read_markers_user').on(table.userId),
  }),
);

export type SubchatReadMarkerRow = typeof subchatReadMarkers.$inferSelect;
