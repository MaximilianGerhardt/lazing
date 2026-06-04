/**
 * Drizzle schema for the events table.
 *
 * Corresponds 1:1 to the `LazyEvent` interface from `lib/events/types.ts`.
 * Payload is stored as a JSON string (SQLite has no real JSON type).
 *
 * Phase 6 (persistence upgrade): migration to Turso/Vercel-Postgres —
 * the schema stays identical, only the driver/client changes.
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    createdAt: integer("created_at").notNull(),
    segmentId: text("segment_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    payload: text("payload").notNull().default("{}"),
    sensitivity: text("sensitivity").notNull().default("low"),
    signature: text("signature"),
    replayedFrom: text("replayed_from"),
  },
  (table) => ({
    bySegmentTime: index("idx_events_segment_created").on(
      table.segmentId,
      sql`${table.createdAt} DESC`,
    ),
    byEntity: index("idx_events_entity").on(
      table.entityType,
      table.entityId,
      sql`${table.createdAt} DESC`,
    ),
    byType: index("idx_events_type").on(table.eventType),
  }),
);

export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
