/**
 * Drizzle schema for the GitHub integration (migration 0092).
 *
 * Source: Lazing-V2 `packages/runtime/src/store/migrations/012-github-
 * substrate.ts`. Adaptation for laz.ing:
 *   - User scope instead of workspace scope for the connection (1 user ↔ 1
 *     GitHub account).
 *   - A dedicated `workspace_github_repos` N:1 table instead of an inline column
 *     on `workspaces.github_repo`, because laz.ing workspaces often have several
 *     repos (e.g. Demo PV CRM + Web).
 *   - Audit lands in `audit_log` (migration 0026), not in a
 *     dedicated `github_audit` table.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { workspaces } from "./workspaces";

export const githubCredentials = sqliteTable(
  "github_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** 'pat' = Personal Access Token (default), 'oauth' = OAuth App flow. */
    authKind: text("auth_kind").notNull().default("pat"),
    /** AES-256-GCM ciphertext (lib/security/credentials.ts format). */
    encryptedToken: text("encrypted_token").notNull(),
    /** GitHub-Login (`octocat`) — set from `/user` after connect. */
    githubLogin: text("github_login"),
    /** Stable numeric GitHub-User-ID (survives renames). */
    githubUserId: integer("github_user_id"),
    avatarUrl: text("avatar_url"),
    /** OAuth-only: encrypted refresh token. PAT leaves NULL. */
    encryptedRefresh: text("encrypted_refresh"),
    /** OAuth-only: granted scope string ("repo,user:email"). */
    scope: text("scope"),
    /** OAuth-only: token expiry epoch-ms. PAT typically NULL (or 1y rotation). */
    expiresAt: integer("expires_at"),
    /** Last successful `/user` validate timestamp (UX + audit). */
    lastValidatedAt: integer("last_validated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byUser: index("idx_github_credentials_user").on(table.userId),
    uniqUser: uniqueIndex("uniq_github_credentials_user").on(table.userId),
  }),
);

export const workspaceGithubRepos = sqliteTable(
  "workspace_github_repos",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    /** `owner/repo` lowercase. Soft-FK against GitHub-API (source of truth). */
    repoFullName: text("repo_full_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    /** Mirrored `repo.private` flag (0 = public, 1 = private). */
    isPrivate: integer("is_private").notNull().default(0),
    description: text("description"),
    /** Epoch-ms of the most recent successful list-refresh on this binding. */
    lastSyncAt: integer("last_sync_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_workspace_github_repos_workspace").on(table.workspaceId),
    byUser: index("idx_workspace_github_repos_user").on(table.userId),
    byRepo: index("idx_workspace_github_repos_repo").on(table.repoFullName),
    uniqUserRepo: uniqueIndex("uniq_workspace_github_repos_user_repo").on(
      table.userId,
      table.repoFullName,
    ),
  }),
);

export type GithubCredentialRow = typeof githubCredentials.$inferSelect;
export type GithubCredentialInsert = typeof githubCredentials.$inferInsert;
export type WorkspaceGithubRepoRow = typeof workspaceGithubRepos.$inferSelect;
export type WorkspaceGithubRepoInsert = typeof workspaceGithubRepos.$inferInsert;
