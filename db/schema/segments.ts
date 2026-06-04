/**
 * Drizzle schema for the segments lookup table.
 *
 * Segments are the lazyos top-level spaces (@north, @clientb, @own,
 * @private, @system). This table mainly serves as a label/accent store for
 * the UI and as a seed marker (empty = auto-seed has not run yet).
 *
 * Note: `north` and `clientb` are legacy accent slot names, not client
 * references.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  accent: text("accent").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type SegmentRow = typeof segments.$inferSelect;
export type SegmentInsert = typeof segments.$inferInsert;
