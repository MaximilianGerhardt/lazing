/**
 * DB-Repo for GitHub credentials + workspace_github_repos.
 *
 * Server-only — uses raw better-sqlite3 prepared statements via
 * `getDb().$raw` (same pattern as `app/api/workspaces/[id]/credentials/
 * route.ts`).
 */

import { randomUUID } from "node:crypto";

import { getDb } from "@/db/client";

export interface GithubCredentialRow {
  id: string;
  user_id: string;
  auth_kind: "pat" | "oauth";
  encrypted_token: string;
  github_login: string | null;
  github_user_id: number | null;
  avatar_url: string | null;
  encrypted_refresh: string | null;
  scope: string | null;
  expires_at: number | null;
  last_validated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceGithubRepoRow {
  id: string;
  workspace_id: string;
  user_id: string;
  repo_full_name: string;
  repo_url: string;
  default_branch: string;
  is_private: number;
  description: string | null;
  last_sync_at: number | null;
  created_at: number;
  updated_at: number;
}

// ─── github_credentials ──────────────────────────────────────────────

export function findCredentialForUser(userId: string): GithubCredentialRow | null {
  const db = getDb();
  const row = db.$raw
    .prepare("SELECT * FROM github_credentials WHERE user_id = ?")
    .get(userId) as GithubCredentialRow | undefined;
  return row ?? null;
}

export interface UpsertCredentialInput {
  userId: string;
  authKind: "pat" | "oauth";
  encryptedToken: string;
  githubLogin: string | null;
  githubUserId: number | null;
  avatarUrl: string | null;
  encryptedRefresh?: string | null;
  scope?: string | null;
  expiresAt?: number | null;
}

export function upsertCredential(input: UpsertCredentialInput): GithubCredentialRow {
  const db = getDb();
  const now = Date.now();
  const existing = findCredentialForUser(input.userId);
  if (existing) {
    db.$raw
      .prepare(
        `UPDATE github_credentials SET
           auth_kind = ?, encrypted_token = ?, github_login = ?,
           github_user_id = ?, avatar_url = ?, encrypted_refresh = ?,
           scope = ?, expires_at = ?, last_validated_at = ?, updated_at = ?
         WHERE user_id = ?`,
      )
      .run(
        input.authKind,
        input.encryptedToken,
        input.githubLogin,
        input.githubUserId,
        input.avatarUrl,
        input.encryptedRefresh ?? null,
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
        input.userId,
      );
  } else {
    db.$raw
      .prepare(
        `INSERT INTO github_credentials (
           id, user_id, auth_kind, encrypted_token, github_login,
           github_user_id, avatar_url, encrypted_refresh, scope,
           expires_at, last_validated_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `ghc-${randomUUID()}`,
        input.userId,
        input.authKind,
        input.encryptedToken,
        input.githubLogin,
        input.githubUserId,
        input.avatarUrl,
        input.encryptedRefresh ?? null,
        input.scope ?? null,
        input.expiresAt ?? null,
        now,
        now,
        now,
      );
  }
  const updated = findCredentialForUser(input.userId);
  if (!updated) {
    throw new Error("upsertCredential: row missing after insert/update");
  }
  return updated;
}

export function deleteCredential(userId: string): boolean {
  const db = getDb();
  const res = db.$raw
    .prepare("DELETE FROM github_credentials WHERE user_id = ?")
    .run(userId);
  return res.changes > 0;
}

export function touchValidated(userId: string): void {
  const db = getDb();
  db.$raw
    .prepare("UPDATE github_credentials SET last_validated_at = ? WHERE user_id = ?")
    .run(Date.now(), userId);
}

// ─── workspace_github_repos ──────────────────────────────────────────

export function listReposForWorkspace(
  workspaceId: string,
): WorkspaceGithubRepoRow[] {
  const db = getDb();
  return db.$raw
    .prepare(
      `SELECT * FROM workspace_github_repos
       WHERE workspace_id = ?
       ORDER BY repo_full_name ASC`,
    )
    .all(workspaceId) as WorkspaceGithubRepoRow[];
}

export function listReposForUser(userId: string): WorkspaceGithubRepoRow[] {
  const db = getDb();
  return db.$raw
    .prepare(
      `SELECT * FROM workspace_github_repos
       WHERE user_id = ?
       ORDER BY repo_full_name ASC`,
    )
    .all(userId) as WorkspaceGithubRepoRow[];
}

export function findRepoBinding(
  userId: string,
  repoFullName: string,
): WorkspaceGithubRepoRow | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT * FROM workspace_github_repos
       WHERE user_id = ? AND repo_full_name = ?`,
    )
    .get(userId, repoFullName) as WorkspaceGithubRepoRow | undefined;
  return row ?? null;
}

export interface LinkRepoInput {
  workspaceId: string;
  userId: string;
  repoFullName: string;
  repoUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string | null;
}

export function linkRepoToWorkspace(input: LinkRepoInput): WorkspaceGithubRepoRow {
  const db = getDb();
  const now = Date.now();
  const existing = findRepoBinding(input.userId, input.repoFullName);
  if (existing) {
    // Re-bind to (possibly different) workspace. We update rather than
    // duplicate — UNIQUE(user_id, repo_full_name) would block anyway.
    db.$raw
      .prepare(
        `UPDATE workspace_github_repos SET
           workspace_id = ?, repo_url = ?, default_branch = ?,
           is_private = ?, description = ?, last_sync_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.workspaceId,
        input.repoUrl,
        input.defaultBranch,
        input.isPrivate ? 1 : 0,
        input.description,
        now,
        now,
        existing.id,
      );
    const updated = findRepoBinding(input.userId, input.repoFullName);
    if (!updated) throw new Error("linkRepoToWorkspace: row missing after update");
    return updated;
  }
  const id = `wsgr-${randomUUID()}`;
  db.$raw
    .prepare(
      `INSERT INTO workspace_github_repos (
         id, workspace_id, user_id, repo_full_name, repo_url,
         default_branch, is_private, description, last_sync_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.workspaceId,
      input.userId,
      input.repoFullName,
      input.repoUrl,
      input.defaultBranch,
      input.isPrivate ? 1 : 0,
      input.description,
      now,
      now,
      now,
    );
  const inserted = findRepoBinding(input.userId, input.repoFullName);
  if (!inserted) throw new Error("linkRepoToWorkspace: row missing after insert");
  return inserted;
}

export function unlinkRepoBinding(id: string, userId: string): boolean {
  const db = getDb();
  const res = db.$raw
    .prepare(
      "DELETE FROM workspace_github_repos WHERE id = ? AND user_id = ?",
    )
    .run(id, userId);
  return res.changes > 0;
}
