/**
 * Drizzle schema for organizations.
 *
 * Organizations are the business level above workspaces. Each workspace
 * belongs to exactly one organization (via workspaces.organization_id FK).
 * Types model the lazyOS hierarchy:
 *
 *   company   — the umbrella (e.g. "Example Company")
 *   client    — client of the company (e.g. "Demo PV", workspace demo-client)
 *   product   — the company's own product (e.g. "lazyOS", "example-product-c/example-brand")
 *   tool      — the company's own tool (e.g. "example-tool")
 *   archived  — no longer active, read-only
 *   private   — Max personally, outside the company
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const ORGANIZATION_TYPES = [
  "company",
  "client",
  "product",
  "tool",
  "archived",
  "private",
] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(), // slug, z.B. "example-company"
    name: text("name").notNull(),
    type: text("type").notNull().default("company"),
    parentId: text("parent_id"),
    paletteIndex: integer("palette_index").notNull().default(0), // 0..39
    description: text("description"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byType: index("idx_organizations_type").on(table.type),
    byParent: index("idx_organizations_parent").on(table.parentId),
  }),
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationInsert = typeof organizations.$inferInsert;
