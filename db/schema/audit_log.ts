/**
 * Drizzle schema for the org audit log (SP-1).
 *
 * Separation from the event log (`db/schema/events.ts`):
 *   - `events.ts` = business-domain append-only log (tickets, decisions, workflow).
 *   - `audit_log.ts` = auth/identity/org audit (login, invite, member change, org edit).
 *
 * GDPR:
 *   - Actor is `user:<id>` | `agent:<id>` | `system` — IDs are ULIDs from
 *     `users.id`, NOT a plaintext e-mail. A right-to-be-forgotten request
 *     deletes the user row; the audit log entry remains with the pseudonymous
 *     `user:<id>` reference — the e-mail is never stored directly in the log.
 *   - `ip` + `user_agent` are mandatory for auth incidents (forensics) and, per
 *     Art. 5(1)(c) data minimization, are only stored for auth actions.
 *   - Retention: 24 months (default), prunable via cron.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const AUDIT_ACTIONS = [
  // Auth
  "magic.issued",
  "magic.verified",
  "magic.expired",
  "magic.duplicate-consume",
  "session.created",
  "session.invalidated",
  // Org
  "org.created",
  "org.updated",
  "org.archived",
  "org.brand-updated",
  // Membership
  "member.invited",
  "member.joined",
  "member.role-changed",
  "member.removed",
  // User
  "user.created",
  "user.deleted",
  "user.suspended",
  "user.unsuspended",
  // Workspace
  "workspace.org-changed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number] | string;

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull(),
    /** "user:<ulid>" | "agent:<id>" | "system:bridge" | "system" */
    actor: text("actor").notNull(),
    /** Action slug from AUDIT_ACTIONS. */
    action: text("action").notNull(),
    orgId: text("org_id"),
    workspaceId: text("workspace_id"),
    targetUserId: text("target_user_id"),
    /** JSON blob with action-specific payload. */
    payload: text("payload"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => ({
    byTs: index("idx_audit_ts").on(table.ts),
    byOrg: index("idx_audit_org").on(table.orgId),
    byActor: index("idx_audit_actor").on(table.actor),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
