/**
 * Workspace-Path-Registry — Read/Write-Repo (Slice FS-1, 2026-05-26).
 * --------------------------------------------------------------------
 *
 * Schließt die Kern-Lücke aus dem Workspace-Isolation-Modell
 * (docs/plans/2026-05-26_workspace-isolation-model.md §1.4 + §4.1):
 * ein Workspace = 1..n Repos/Verzeichnisse, NICHT genau ein Pfad.
 *
 * Owner-Direktive (verbatim): „Es soll ganz klar so sein, dass jedes Projekt
 * isoliert betrachtet wird … ich habe z.B. bei einem Projekt ein CRM —
 * eigenes Git — und eine Webseite. Beides gehört aber zum selben
 * Projekt/Workspace."
 *
 * Diese Datei persistiert die FS-Roots. Sie setzt KEINE Pfad-Whitelist durch
 * (Pfade dürfen überall liegen) und KEINE Schreib-Politik — das ist Aufgabe
 * des Executors / der Sandbox-Profil-Generierung (§4.2/§4.3).
 *
 * Die Funktionen nehmen eine `better-sqlite3`-Database direkt entgegen
 * (test-friendly: in-memory-DB ohne den getDb()-Singleton möglich).
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
  /** Der primary-Root-Pfad (Rückwärtskompat = workspaces.path). */
  primary: string;
  /** ALLE Roots inkl. primary. */
  roots: FsRoot[];
  /** Nur access==='rw'. */
  rwRoots: FsRoot[];
  /** Nur access==='ro'. */
  roRoots: FsRoot[];
}

/** Raw DB-Row (snake_case, is_git als 0|1). */
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
 * Alle FS-Roots eines Workspace. primary-Roots zuerst (stabile Ordnung für
 * den Resolver), dann nach created_at.
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
 * Fügt einen FS-Root hinzu. Defaults: role='repo', access='rw', isGit=true.
 * Wirft bei UNIQUE(workspace_id, abs_path)-Verletzung (besser-sqlite3
 * SqliteError mit code 'SQLITE_CONSTRAINT_UNIQUE').
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

/** Ergebnis von {@link removeWorkspaceRoot}. */
export interface RemoveWorkspaceRootResult {
  /** true wenn eine Row tatsächlich gelöscht wurde. */
  removed: boolean;
  /**
   * Grund falls NICHT gelöscht:
   *   - 'primary_protected': Row hat role='primary' (gespiegelter
   *     workspaces.path) und darf nicht über die Registry gelöscht werden.
   *   - 'not_found': keine Row mit dieser id.
   */
  reason?: "primary_protected" | "not_found";
}

/**
 * Entfernt einen FS-Root anhand der Row-ID.
 *
 * Defense-in-depth (FS-1, Design-Doc §4.1): eine role='primary'-Row (der
 * gespiegelte workspaces.path) wird NICHT gelöscht — sie bleibt erhalten und
 * das Ergebnis trägt reason='primary_protected'. Unbekannte id → no-op mit
 * reason='not_found'. Beide Fälle werfen NICHT.
 *
 * Rückgabe-Erweiterung ist additiv: Aufrufer, die `void` erwarten (statement-
 * call), werden nicht gebrochen — sie ignorieren das Result schlicht.
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
 * FS-1: aktualisiert die ro/rw-Zugriffspolitik eines FS-Roots (PATCH-Pfad).
 *
 * Sauberer expliziter Toggle statt idempotenz-fragilem Re-POST. Setzt
 * `access` + `updated_at=now` und gibt die aktualisierte Row zurück, oder
 * null wenn keine Row mit dieser id existiert. Berührt role/abs_path NICHT.
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
 * IDEMPOTENT: spiegelt `workspaces.path` als role='primary'-Root.
 *
 * - Existiert bereits eine Row mit (workspace_id, abs_path=path): no-op
 *   (gibt die bestehende Row zurück; aktualisiert sie auf role='primary' +
 *   updated_at falls sie zuvor eine andere Rolle hatte).
 * - Sonst: legt eine neue role='primary', access='rw', isGit=1 Row an.
 *
 * Genutzt von discover-workspaces.ts nach jedem Upsert (§4.1). Nutzt
 * UNIQUE(workspace_id, abs_path) als Idempotenz-Schlüssel.
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
    // Idempotent: stelle role='primary' sicher (z.B. falls vorher als 'repo'
    // angelegt), sonst no-op. Kein zweiter INSERT → bleibt EINE Row.
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
 * FS-2-Kern: löst die effektiven Roots eines Workspace auf.
 *
 * Read-only-Resolver: spiegelt NICHTS automatisch.
 *
 * - Wenn fs_roots-Rows existieren: primary = der Pfad der role='primary'-Row
 *   (oder, falls keine primary-Row existiert, der erste Root als Fallback);
 *   roots = ALLE Rows; rwRoots/roRoots gefiltert nach access.
 * - Wenn KEINE Rows existieren: Fallback auf workspaces.path (liest die Row).
 *   primary = workspaces.path falls gesetzt, sonst '' . roots=[] wenn der
 *   Pfad leer/fehlt (Q1: synthetischer 'private'-Workspace darf 0 Roots haben).
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

  // Fallback: keine Registry-Rows → lies workspaces.path (Rückwärtskompat).
  // Spiegelt NICHT (read-only). Wirft NICHT wenn workspaces fehlt.
  let path = "";
  try {
    const wsRow = db
      .prepare(`SELECT path FROM workspaces WHERE id = ? LIMIT 1`)
      .get(workspaceId) as { path?: string | null } | undefined;
    path = (wsRow?.path ?? "").trim();
  } catch {
    // workspaces-Tabelle existiert evtl. nicht (isolierter Test) → leer.
    path = "";
  }

  return {
    primary: path,
    roots: [],
    rwRoots: [],
    roRoots: [],
  };
}
