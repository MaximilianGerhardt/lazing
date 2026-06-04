/**
 * Drizzle schema for work products (Sprint 2 · Section 7I).
 *
 * Each ticket row can have 0..N artifacts: agent output, user upload,
 * markdown report, PDF, email draft, JSON dump, URL.
 *
 * Design decisions:
 *   - `content` is TEXT. For `markdown|url|json|email|code_diff` inline,
 *     for `pdf` the relative path to `~/.lazyos/work-products/`.
 *   - No hard FK on tickets — tickets exist only as a projection
 *     from the event log. Referential integrity is enforced at the service
 *     layer (projectTicket()).
 *   - Soft-delete via `status='superseded'` (never DROP ROW).
 */

import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workProducts = sqliteTable(
  "work_products",
  {
    /** WP-<nanoid(10)>. Primary Key. */
    id: text("id").primaryKey(),
    /** Ticket-ID (TCK-<ULID>). Kein harter FK — Tickets sind Projektion. */
    ticketId: text("ticket_id").notNull(),
    /** 'markdown'|'url'|'code_diff'|'pdf'|'email'|'json' */
    type: text("type").notNull(),
    title: text("title").notNull(),
    /** Inline-Content oder PDF-Pfad. */
    content: text("content").notNull().default(""),
    /** MIME-Type, optional. */
    mime: text("mime"),
    /** Groesse in Bytes (UTF-8). Vom Service gesetzt. */
    bytes: integer("bytes").notNull().default(0),
    /** 'draft'|'final'|'superseded' */
    status: text("status").notNull().default("draft"),
    /** 'user' | 'user:<name>' | 'agent:<name>'. */
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byTicket: index("idx_work_products_ticket").on(
      table.ticketId,
      sql`${table.createdAt} DESC`,
    ),
    byStatus: index("idx_work_products_status").on(table.status),
  }),
);

export type WorkProductRow = typeof workProducts.$inferSelect;
export type WorkProductInsert = typeof workProducts.$inferInsert;
