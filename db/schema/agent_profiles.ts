/**
 * Drizzle schema — "employee" profiles (agent profiles, 2026-06-03).
 *
 * Research: docs/research/2026-06-03_skills-mcp-skillcreator-research.md §4.
 *
 * Owner vision: "create a kind of employee (agent) for specific
 * combinations [of skills/MCPs/SOPs/APIs]." In the laz.ing model an "employee"
 * is NOT a permanent agent user (CLAUDE.md forbids the Slack pattern), but
 * a NAMED, persisted role definition + an allow-listed capability
 * bundle that is spawned ad-hoc. That is the missing piece: laz.ing already has
 * roles (spawner-types.ts) + role→skill map (role-skill-map.ts), but
 * no named, reusable profile that captures a specific combination.
 *
 * Components (research §4.1):
 *   Role (SubagentRole) + Skills[] + MCP servers[] + SOPs[] + APIs[]
 *   + ManifestCoord (workspace_id/org_id, N9) + policy gate (least-privilege).
 *
 * Discipline: N1 (name/description verbatim), N9 (ManifestCoord scope),
 * append-light (archived_at soft-delete instead of deleting).
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const agentProfiles = sqliteTable(
  'agent_profiles',
  {
    /** ULID, prefix `AGP-`. */
    id: text('id').primaryKey(),
    /** N1 verbatim display name, e.g. "customer-report employee North". */
    name: text('name').notNull(),
    /** N1 verbatim purpose/description. */
    description: text('description'),
    /** laz.ing role from spawner-types.SubagentRole (validated on creation). */
    role: text('role').notNull(),
    /** Allow-listed skill bundle (JSON string[]) — becomes, on spawn, the
     *  ROLE_SKILL_MAP override allowlist (least-privilege). */
    skillsJson: text('skills_json').notNull().default('[]'),
    /** Allowed MCP servers (JSON string[]). */
    mcpServersJson: text('mcp_servers_json').notNull().default('[]'),
    /** Required SOPs with gate (JSON string[], e.g. lazing-policy-checker). */
    sopsJson: text('sops_json').notNull().default('[]'),
    /** Allowed APIs/endpoints (JSON string[], workspace-credentials-scoped). */
    apisJson: text('apis_json').notNull().default('[]'),
    /** ManifestCoord scope (N9). NULL = personal/global (no workspace bind). */
    workspaceId: text('workspace_id'),
    /** Optional org scope. */
    orgId: text('org_id'),
    /** Who created the profile. */
    createdBy: text('created_by'),
    /** Epoch ms. */
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    /** Soft-delete: epoch ms; NULL = active. */
    archivedAt: integer('archived_at'),
  },
  (table) => ({
    byWorkspace: index('idx_agent_profiles_workspace').on(table.workspaceId),
    byOrg: index('idx_agent_profiles_org').on(table.orgId),
    byActive: index('idx_agent_profiles_active').on(table.archivedAt),
  }),
);

export type AgentProfileRow = typeof agentProfiles.$inferSelect;
