/**
 * Drizzle schema for memberships (Phase ORG SP-1).
 *
 * Two tables:
 *   - org_memberships         user ↔ organization with role
 *   - workspace_memberships   user ↔ workspace, optional as an override of the org role
 *
 * Inheritance rule:
 *   - If workspace_memberships.inheritsFromOrg=true AND a row exists,
 *     the explicit workspace role applies as an override.
 *   - If no workspace_memberships row exists: the role is derived from
 *     org_memberships.role (provided the workspace belongs to an org).
 *   - Guest = workspace membership without org membership; org tabs hidden,
 *     only this one workspace visible.
 *
 * Soft-FK on users + organizations + workspaces — we do NOT rely on
 * SQLite FK CASCADE, because better-sqlite3 + Drizzle do not propagate it
 * consistently. Cleanup happens at the service layer.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const MEMBERSHIP_ROLES = [
  "founder",
  "admin",
  "member",
  "viewer",
  "guest",
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/* ------------------------------------------------------------------ */
/* org_memberships                                                    */
/* ------------------------------------------------------------------ */

export const orgMemberships = sqliteTable(
  "org_memberships",
  {
    /** ULID. */
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    role: text("role").notNull(),
    invitedByUserId: text("invited_by_user_id"),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byUser: index("idx_orgmem_user").on(table.userId),
    byOrg: index("idx_orgmem_org").on(table.orgId),
    /** UNIQUE is set at the SQL level via CREATE UNIQUE INDEX — see the migration. */
  }),
);

export type OrgMembershipRow = typeof orgMemberships.$inferSelect;
export type OrgMembershipInsert = typeof orgMemberships.$inferInsert;

/* ------------------------------------------------------------------ */
/* workspace_memberships                                              */
/* ------------------------------------------------------------------ */

export const workspaceMemberships = sqliteTable(
  "workspace_memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    role: text("role").notNull(),
    /** true = the role is only an annotation; effectively org_memberships.role counts. */
    inheritsFromOrg: integer("inherits_from_org", { mode: "boolean" })
      .notNull()
      .default(true),
    invitedByUserId: text("invited_by_user_id"),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byUser: index("idx_wsmem_user").on(table.userId),
    byWorkspace: index("idx_wsmem_workspace").on(table.workspaceId),
  }),
);

export type WorkspaceMembershipRow = typeof workspaceMemberships.$inferSelect;
export type WorkspaceMembershipInsert = typeof workspaceMemberships.$inferInsert;
