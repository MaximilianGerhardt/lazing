/**
 * Drizzle schema for the `skills` table (Phase S — skill first-class).
 *
 * Skill = "what an agent focuses on". Previously a hardcoded list in
 * lib/agents/diversity-roles.ts; now a first-class entity so user-defined
 * skills, a /skills editor and workstream-specific skill mixes become possible.
 *
 * Skill ≠ tier (capacity). Skill ≠ effort (reasoning depth). A spawn slot
 * is a (skillId, tier, effort, count) tuple.
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const skills = sqliteTable(
  'skills',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    focusPrompt: text('focus_prompt').notNull(),
    /** opus | sonnet | haiku — Default-Tier wenn Workstream keinen Override gibt. */
    preferTier: text('prefer_tier').notNull().default('sonnet'),
    /** xhigh | high | medium | low. */
    defaultEffort: text('default_effort').notNull().default('medium'),
    /** Wie viele Slots dieses Skill pro Spawn idealerweise belegt. */
    defaultCount: integer('default_count').notNull().default(1),
    description: text('description'),
    /** 1 = Built-in (Seed); read-only fuer User. 0 = User-defined. */
    builtIn: integer('built_in', { mode: 'boolean' }).notNull().default(false),
    archivedAt: integer('archived_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    byActive: index('idx_skills_active').on(table.archivedAt, table.name),
  }),
);

export type SkillRow = typeof skills.$inferSelect;
export type SkillInsert = typeof skills.$inferInsert;
