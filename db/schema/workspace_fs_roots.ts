/**
 * Drizzle schema for the workspace path registry (migration 0111, Slice FS-1).
 *
 * Closes the core gap in the workspace isolation model
 * (docs/plans/2026-05-26_workspace-isolation-model.md §1.4 + §4.1):
 *
 * Until now a workspace had EXACTLY ONE path (`workspaces.path`,
 * single-valued). But the owner directive requires: one workspace =
 * 1..n repos/directories (CRM git + website git = ONE workspace).
 *
 * Each row is a local FS root (real Mac path, e.g.
 * <workspace-dir>) that the executor/sandbox uses as a
 * scope boundary.
 *
 * - role='primary' mirrors `workspaces.path` (backward-compat).
 * - access='ro' allows read-only roots (e.g. a docs library read-only).
 * - github_repo_id is an OPTIONAL soft-FK on workspace_github_repos.id
 *   (REMOTE coordinates) — deliberately NOT a real FK (the table is remote-only
 *   and may be missing).
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { workspaces } from "./workspaces";

export const workspaceFsRoots = sqliteTable(
  "workspace_fs_roots",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Echter absoluter Mac-Pfad, z.B. <workspace-dir> */
    absPath: text("abs_path").notNull(),
    /** 'primary' (spiegelt workspaces.path) | 'repo' | 'dir'. */
    role: text("role").notNull().default("repo"),
    /** 'ro' (read-only) | 'rw' (read-write). */
    access: text("access").notNull().default("rw"),
    /** 1 wenn eigenes Git-Repo, 0 = reines Verzeichnis. */
    isGit: integer("is_git").notNull().default(1),
    /** Optionaler Soft-FK auf workspace_github_repos.id (NULL erlaubt). */
    githubRepoId: text("github_repo_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    byWorkspace: index("idx_ws_fs_roots_ws").on(table.workspaceId),
  }),
);

export type WorkspaceFsRootRow = typeof workspaceFsRoots.$inferSelect;
export type WorkspaceFsRootInsert = typeof workspaceFsRoots.$inferInsert;
