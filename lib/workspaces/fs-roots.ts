/**
 * Workspace path registry — read/write repo (slice FS-1, 2026-05-26).
 * --------------------------------------------------------------------
 *
 * Closes the core gap from the workspace isolation model
 * (docs/plans/2026-05-26_workspace-isolation-model.md §1.4 + §4.1):
 * a workspace = 1..n repos/directories, NOT exactly one path.
 *
 * Owner directive (verbatim): „Es soll ganz klar so sein, dass jedes Projekt
 * isoliert betrachtet wird … ich habe z.B. bei einem Projekt ein CRM —
 * eigenes Git — und eine Webseite. Beides gehört aber zum selben
 * Projekt/Workspace."
 *
 * This file persists the FS roots. It enforces NO path whitelist
 * (paths may live anywhere) and NO write policy — that is the job of
 * the executor / the sandbox-profile generation (§4.2/§4.3).
 *
 * The functions take a `better-sqlite3` Database directly
 * (test-friendly: an in-memory DB without the getDb() singleton is possible).
 */

import { randomUUID } from "node:crypto";

import type { Database } from "better-sqlite3";

export interface FsRoot {
  id: string;
  workspaceId: string;
  absPath: string;
  role: "primary" | "repo" | "dir";
  access: "ro" | "rw";
  isGit: boolean;
  githubRepoId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ResolvedWorkspaceRoots {
  /** The primary root path (backwards-compat = workspaces.path). */
  primary: string;
  /** ALL roots incl. primary. */
  roots: FsRoot[];
  /** Only access==='rw'. */
  rwRoots: FsRoot[];
  /** Only access==='ro'. */
  roRoots: FsRoot[];
}

/** Raw DB row (snake_case, is_git as 0|1). */
interface FsRootDbRow {
  id: string;
  workspace_id: string;
  abs_path: string;
  role: string;
  access: string;
  is_git: number;
  github_repo_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToFsRoot(row: FsRootDbRow): FsRoot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    absPath: row.abs_path,
    role: row.role as FsRoot["role"],
    access: row.access as FsRoot["access"],
    isGit: row.is_git === 1,
    githubRepoId: row.github_repo_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * All FS roots of a workspace. primary roots first (stable ordering for
 * the resolver), then by created_at.
 */
export function listWorkspaceRoots(db: Database, workspaceId: string): FsRoot[] {
  const rows = db
    .prepare(
      `SELECT id, workspace_id, abs_path, role, access, is_git, github_repo_id,
              created_at, updated_at
         FROM workspace_fs_roots
        WHERE workspace_id = ?
        ORDER BY (role = 'primary') DESC, created_at ASC, id ASC`,
    )
    .all(workspaceId) as FsRootDbRow[];
  return rows.map(rowToFsRoot);
}

/**
 * Adds an FS root. Defaults: role='repo', access='rw', isGit=true.
 * Throws on a UNIQUE(workspace_id, abs_path) violation (better-sqlite3
 * SqliteError with code 'SQLITE_CONSTRAINT_UNIQUE').
 */
export function addWorkspaceRoot(
  db: Database,
  input: {
    workspaceId: string;
    absPath: string;
    role?: "primary" | "repo" | "dir";
    access?: "ro" | "rw";
    isGit?: boolean;
    githubRepoId?: string | null;
  },
): FsRoot {
  const id = `fsroot-${randomUUID()}`;
  const now = Date.now();
  const role = input.role ?? "repo";
  const access = input.access ?? "rw";
  const isGit = input.isGit === undefined ? 1 : input.isGit ? 1 : 0;
  const githubRepoId = input.githubRepoId ?? null;

  db.prepare(
    `INSERT INTO workspace_fs_roots
       (id, workspace_id, abs_path, role, access, is_git, github_repo_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.absPath,
    role,
    access,
    isGit,
    githubRepoId,
    now,
    now,
  );

  return {
    id,
    workspaceId: input.workspaceId,
    absPath: input.absPath,
    role,
    access,
    isGit: isGit === 1,
    githubRepoId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Result of {@link removeWorkspaceRoot}. */
export interface RemoveWorkspaceRootResult {
  /** true when a row was actually deleted. */
  removed: boolean;
  /**
   * Reason if NOT deleted:
   *   - 'primary_protected': the row has role='primary' (the mirrored
   *     workspaces.path) and must not be deleted via the registry.
   *   - 'not_found': no row with this id.
   */
  reason?: "primary_protected" | "not_found";
}

/**
 * Removes an FS root by row ID.
 *
 * Defense-in-depth (FS-1, design doc §4.1): a role='primary' row (the
 * mirrored workspaces.path) is NOT deleted — it is kept and
 * the result carries reason='primary_protected'. Unknown id → no-op with
 * reason='not_found'. Neither case throws.
 *
 * The return-value extension is additive: callers expecting `void` (a statement
 * call) are not broken — they simply ignore the result.
 */
export function removeWorkspaceRoot(
  db: Database,
  id: string,
): RemoveWorkspaceRootResult {
  const row = db
    .prepare(`SELECT role FROM workspace_fs_roots WHERE id = ? LIMIT 1`)
    .get(id) as { role?: string } | undefined;

  if (!row) {
    return { removed: false, reason: "not_found" };
  }
  if (row.role === "primary") {
    return { removed: false, reason: "primary_protected" };
  }

  const info = db
    .prepare(`DELETE FROM workspace_fs_roots WHERE id = ?`)
    .run(id);
  return { removed: info.changes > 0 };
}

/**
 * FS-1: updates the ro/rw access policy of an FS root (PATCH path).
 *
 * A clean, explicit toggle instead of an idempotency-fragile re-POST. Sets
 * `access` + `updated_at=now` and returns the updated row, or
 * null when no row with this id exists. Does NOT touch role/abs_path.
 */
export function updateWorkspaceRootAccess(
  db: Database,
  id: string,
  access: "ro" | "rw",
): FsRoot | null {
  const now = Date.now();
  const info = db
    .prepare(
      `UPDATE workspace_fs_roots SET access = ?, updated_at = ? WHERE id = ?`,
    )
    .run(access, now, id);

  if (info.changes === 0) {
    return null;
  }

  const row = db
    .prepare(
      `SELECT id, workspace_id, abs_path, role, access, is_git, github_repo_id,
              created_at, updated_at
         FROM workspace_fs_roots
        WHERE id = ?
        LIMIT 1`,
    )
    .get(id) as FsRootDbRow | undefined;

  return row ? rowToFsRoot(row) : null;
}

/**
 * IDEMPOTENT: mirrors `workspaces.path` as a role='primary' root.
 *
 * - If a row with (workspace_id, abs_path=path) already exists: no-op
 *   (returns the existing row; updates it to role='primary' +
 *   updated_at if it previously had a different role).
 * - Otherwise: creates a new role='primary', access='rw', isGit=1 row.
 *
 * Used by discover-workspaces.ts after every upsert (§4.1). Uses
 * UNIQUE(workspace_id, abs_path) as the idempotency key.
 */
export function mirrorPrimaryRoot(
  db: Database,
  workspaceId: string,
  path: string,
): FsRoot {
  const now = Date.now();

  const existing = db
    .prepare(
      `SELECT id, workspace_id, abs_path, role, access, is_git, github_repo_id,
              created_at, updated_at
         FROM workspace_fs_roots
        WHERE workspace_id = ? AND abs_path = ?
        LIMIT 1`,
    )
    .get(workspaceId, path) as FsRootDbRow | undefined;

  if (existing) {
    // Idempotent: ensure role='primary' (e.g. if previously created as 'repo'),
    // otherwise no-op. No second INSERT → stays ONE row.
    if (existing.role !== "primary") {
      db.prepare(
        `UPDATE workspace_fs_roots SET role = 'primary', updated_at = ? WHERE id = ?`,
      ).run(now, existing.id);
      existing.role = "primary";
      existing.updated_at = now;
    }
    return rowToFsRoot(existing);
  }

  return addWorkspaceRoot(db, {
    workspaceId,
    absPath: path,
    role: "primary",
    access: "rw",
    isGit: true,
  });
}

/**
 * FS-2 core: resolves the effective roots of a workspace.
 *
 * Read-only resolver: mirrors NOTHING automatically.
 *
 * - When fs_roots rows exist: primary = the path of the role='primary' row
 *   (or, if no primary row exists, the first root as a fallback);
 *   roots = ALL rows; rwRoots/roRoots filtered by access.
 * - When NO rows exist: fall back to workspaces.path (reads the row).
 *   primary = workspaces.path if set, otherwise '' . roots=[] when the
 *   path is empty/missing (Q1: a synthetic 'private' workspace may have 0 roots).
 */
export function resolveWorkspaceRoots(
  db: Database,
  workspaceId: string,
): ResolvedWorkspaceRoots {
  const roots = listWorkspaceRoots(db, workspaceId);

  if (roots.length > 0) {
    const primaryRow = roots.find((r) => r.role === "primary") ?? roots[0];
    return {
      primary: primaryRow.absPath,
      roots,
      rwRoots: roots.filter((r) => r.access === "rw"),
      roRoots: roots.filter((r) => r.access === "ro"),
    };
  }

  // Fallback: no registry rows → read workspaces.path (backwards-compat).
  // Does NOT mirror (read-only). Does NOT throw if workspaces is missing.
  let path = "";
  try {
    const wsRow = db
      .prepare(`SELECT path FROM workspaces WHERE id = ? LIMIT 1`)
      .get(workspaceId) as { path?: string | null } | undefined;
    path = (wsRow?.path ?? "").trim();
  } catch {
    // The workspaces table may not exist (isolated test) → empty.
    path = "";
  }

  return {
    primary: path,
    roots: [],
    rwRoots: [],
    roRoots: [],
  };
}
