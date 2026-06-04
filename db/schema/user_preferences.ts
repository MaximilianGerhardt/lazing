/**
 * Drizzle schema for user defaults (migration 0114, 2026-05-28).
 *
 * Owner finding (live test 2026-05-28, verbatim):
 *   "Full access was already enabled. In the new workspace it was not
 *    enabled. Possibly make this setting usable system-wide."
 *
 * A small, additive table for system-wide user settings. Today
 * only `defaultPermissionMode`, deliberately cut so that further defaults
 * (theme, engine, locale override) can be added later without a migration.
 *
 * Substrate discipline:
 *   - N4: additive — no change to `users` or `lazyos_permission_modes`.
 *   - N9: userId = ManifestCoord subject. No hard FK (analogous to 0111/0112/0113).
 *   - N10: contentHash is set by the application layer (preferences-repo.ts).
 */

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

import { PERMISSION_MODES } from "../../lib-v1/permission/settings/schema";

export const PREFERENCE_SOURCES = [
  "system",
  "permission-toggle",
  "api",
  "migration",
] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

/** Whitelist-Spiegel: nur diese Werte sind in `default_permission_mode` zulässig. */
export const DEFAULT_PERMISSION_MODE_VALUES = PERMISSION_MODES;

export const userPreferences = sqliteTable("user_preferences", {
  /** ULID of the user. PRIMARY KEY → exactly one row per user. */
  userId: text("user_id").primaryKey(),
  /**
   * NULL → the user has not set a default. New workspaces start in
   * `'ask'` (safe default), the UI toggle pill stays OFF.
   */
  defaultPermissionMode: text("default_permission_mode"),
  /** N1 verbatim — why the user set this default. */
  reason: text("reason"),
  /** N8 Provenance. */
  source: text("source").notNull().default("system"),
  /** N10 sha256 über kanonisches JSON, Application-Layer setzt das. */
  contentHash: text("content_hash").notNull().default(""),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export type UserPreferencesRow = typeof userPreferences.$inferSelect;
export type UserPreferencesInsert = typeof userPreferences.$inferInsert;
