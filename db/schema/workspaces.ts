/**
 * Drizzle schema for the workspaces lookup table.
 *
 * Workspaces replace the old dummy segments (@north, @clientb, @own,
 * @private, @system). Each workspace corresponds to a real project
 * under <install-dir>/ plus the synthetic `private` workspace
 * for Max's personal matters.
 *
 * Sensitivity floor:
 *   - `private` + `example-app-*` must have sensitivity='high'
 *   - rest default 'low'
 *
 * Phase 6 (persistence upgrade): migration to Turso/Vercel-Postgres —
 * the schema stays identical, only the driver/client changes.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    accent: text("accent").notNull(),
    path: text("path").notNull(),
    sensitivity: text("sensitivity").notNull().default("low"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    /**
     * P16 (2026-05-01): sandbox-mode flag. 0 = strict (default), 1 = sandbox.
     * Server-side only allowed when sensitivity='low'. In sandbox: auto-
     * approve after synthesis, no routine push notifications. The loop guard
     * stays ALWAYS active (safety requirement).
     */
    sandboxMode: integer("sandbox_mode").notNull().default(0),
    credentialOwner: text("credential_owner"),
    description: text("description"),
    orgChart: text("org_chart"),
    /** Phase ORG: soft-FK on organizations.id. */
    organizationId: text("organization_id"),
    /**
     * Phase IA consolidation (2026-04-29): workspace type for section
     * grouping in /orgs/[id]. Values: company | product | client |
     * tool | private | default. Default "default" → lands in "Other".
     */
    workspaceType: text("workspace_type").notNull().default("default"),
    /**
     * 2026-05-03: user-driven sub-segmentation within an org. Example
     * Demo PV: two workspaces (CRM + Web) grouped under the same
     * sub-header despite different workspace_type. NULL = "General".
     */
    contextGroup: text("context_group"),
    /**
     * ACL-3 (2026-05-24): credential-isolation toggle — ORTHOGONAL to `sensitivity`.
     *
     * sensitivity  → GDPR/RAG indexing axis (unchanged).
     * credentialIsolation → credential inheritance axis (NEW).
     *
     * Values:
     *   'inherit'  — the workspace may use org credentials as a fallback.
     *                Standard for internal products / own tools.
     *   'isolated' — the workspace uses exclusively its own credentials.
     *                No org fallback. Standard for external customers
     *                (org type 'client').
     *
     * Default 'inherit' = backward-compat for all existing workspaces.
     */
    credentialIsolation: text("credential_isolation").notNull().default("inherit"),
    /** Phase Notes: pro-Workspace Mini-CLAUDE.md. */
    notes: text("notes"),
    notesUpdatedAt: integer("notes_updated_at", { mode: "timestamp_ms" }),
    notesSource: text("notes_source"),
    /** Phase Brand: pro-Workspace-Branding (gehört eigentlich in org, ist Legacy). */
    logoUrl: text("logo_url"),
    wordmarkUrl: text("wordmark_url"),
    brandColors: text("brand_colors"),
    brandVoice: text("brand_voice"),
    emailSignature: text("email_signature"),
    canonicalDomain: text("canonical_domain"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    byId: index("idx_workspaces_id").on(table.id),
    byArchived: index("idx_workspaces_archived").on(table.archived),
    byContextGroup: index("idx_workspaces_context_group").on(
      table.organizationId,
      table.contextGroup,
    ),
  }),
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
