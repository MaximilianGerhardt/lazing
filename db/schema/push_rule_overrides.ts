/**
 * Drizzle schema for `push_rule_overrides` (migration 0045, Pattern 6a telemetry).
 *
 * Pattern 6a (wave 2026-05-01) initially only records telemetry via
 * `notification_dismissed_without_action` and `notification_clicked`
 * events (see lib/events/types.ts). Phase 6b (decay algorithm,
 * `lib/push/decay.ts`) follows after a 7d lead time — this table is the
 * persistence slot for the decay decisions, created already now
 * so the schema migration goes live before the algorithm.
 *
 * Read pattern (phase 6b): before `dispatchPushTriggers`, lookup per rule:
 *   SELECT level, locked FROM push_rule_overrides WHERE rule_id = ?
 *   - locked = 1 → effective = level (user override wins)
 *   - decayed_until > now → effective = level (decay active)
 *   - otherwise → fallback = rule.defaultLevel
 *
 * Write pattern (phase 6b): a nightly job aggregates the telemetry from
 * the `events` table (eventType=notification_dismissed_without_action /
 * notification_clicked, grouped by payload.ruleId), computes the
 * dismiss rate, then UPSERTs with decayed_at=now.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pushRuleOverrides = sqliteTable(
  "push_rule_overrides",
  {
    ruleId: text("rule_id").primaryKey(),
    level: text("level").notNull(),
    locked: integer("locked").notNull().default(0),
    reason: text("reason"),
    prevLevel: text("prev_level"),
    decayedAt: integer("decayed_at").notNull(),
    decayedUntil: integer("decayed_until"),
  },
  (table) => ({
    byDecayedAt: index("idx_pro_decayed").on(table.decayedAt),
  }),
);

export type PushRuleOverrideRow = typeof pushRuleOverrides.$inferSelect;
export type PushRuleOverrideInsert = typeof pushRuleOverrides.$inferInsert;
