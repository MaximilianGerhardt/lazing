/**
 * Drizzle schema for the org-level GitHub integration (migration 0096).
 *
 * Design decisions:
 *   - The org owns the GitHub connection (1 org → max. 1 connection via
 *     UNIQUE(org_id)). Workspaces link repos *from* the org connection
 *     (Slice C).
 *   - `encrypted_token` — AES-256-GCM ciphertext (lib/security/credentials.ts).
 *     NEVER return decrypted without an explicit call to
 *     `decryptOrgToken` from `lib/github/org-repo.ts`.
 *   - No `encrypted_refresh` — PAT-first (design decision, RECOVERY.md).
 *     OAuth/app support is a follow-up slice.
 *   - N9: org_id is the scope anchor. All queries on this table
 *     MUST contain `WHERE org_id = ?`.
 *
 * Analogous to `db/schema/github.ts` (user-scoped), but org-scoped.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { organizations } from "./organizations";

export const orgGithubCredentials = sqliteTable(
  "org_github_credentials",
  {
    id: text("id").primaryKey(),
    /** N9 Scope-Anker. Pflicht. */
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 'pat' | 'oauth' | 'github_app' */
    authKind: text("auth_kind").notNull().default("pat"),
    /** AES-256-GCM ciphertext (lib/security/credentials.ts). Never plaintext. */
    encryptedToken: text("encrypted_token").notNull(),
    /** GitHub-Login (`octocat`). Populated via /user on connect. */
    githubLogin: text("github_login"),
    /** Stable numeric GitHub-User-ID (survives renames). */
    githubUserId: integer("github_user_id"),
    avatarUrl: text("avatar_url"),
    /** OAuth-only: granted scope string. PAT leaves NULL. */
    scope: text("scope"),
    /** OAuth/App-only: token expiry epoch-ms. PAT typically NULL. */
    expiresAt: integer("expires_at"),
    /** Last successful /user validate timestamp — UX + N10 audit. */
    lastValidatedAt: integer("last_validated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byOrg: index("idx_org_github_credentials_org").on(table.orgId),
    uniqOrg: uniqueIndex("uniq_org_github_credentials_org").on(table.orgId),
  }),
);

export type OrgGithubCredentialRow = typeof orgGithubCredentials.$inferSelect;
export type OrgGithubCredentialInsert = typeof orgGithubCredentials.$inferInsert;
