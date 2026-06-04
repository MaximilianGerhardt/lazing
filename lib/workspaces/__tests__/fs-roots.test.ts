/**
 * Workspace-Path-Registry Tests (Slice FS-1, 2026-05-26).
 *
 * Run (vitest braucht in diesem Repo das experimental-require-module-Flag):
 *   NODE_OPTIONS="--experimental-require-module" \
 *     node_modules/.bin/vitest run lib/workspaces/__tests__/fs-roots.test.ts
 *
 * In-memory better-sqlite3 — KEIN getDb()-Singleton. Die Migration-.sql wird
 * via readFileSync eingelesen, plus eine minimale `workspaces`-Tabelle für die
 * FK + den workspaces.path-Fallback.
 *
 * Deckt:
 *   - add + list (inkl. Defaults + role/access/isGit-Roundtrip)
 *   - mirrorPrimaryRoot idempotent (2x → EINE Row, role='primary')
 *   - resolveWorkspaceRoots mit 2 Roots (CRM + Web → primary + rwRoots)
 *   - Fallback ohne Rows (liest workspaces.path)
 *   - Fallback ohne Rows + ohne path → primary='' , roots=[]
 *   - remove
 *   - UNIQUE(workspace_id, abs_path)-Conflict
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addWorkspaceRoot,
  listWorkspaceRoots,
  mirrorPrimaryRoot,
  removeWorkspaceRoot,
  resolveWorkspaceRoots,
  updateWorkspaceRootAccess,
} from "../fs-roots";

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../db/migrations/0111_workspace_fs_roots.sql",
);

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  // Minimale workspaces-Tabelle (für FK + workspaces.path-Fallback).
  db.exec(`
    CREATE TABLE workspaces (
      id    TEXT PRIMARY KEY NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      accent TEXT NOT NULL DEFAULT 'own',
      path  TEXT NOT NULL DEFAULT ''
    );
  `);

  // Die echte Migration einlesen (kein hand-kopiertes DDL → Schema-Drift-frei).
  db.exec(readFileSync(MIGRATION_PATH, "utf8"));
});

afterEach(() => {
  db.close();
});

function seedWorkspace(id: string, wsPath: string): void {
  db.prepare(
    `INSERT INTO workspaces (id, label, accent, path) VALUES (?, ?, 'own', ?)`,
  ).run(id, id, wsPath);
}

describe("fs-roots · add + list", () => {
  beforeEach(() => seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm"));

  it("addWorkspaceRoot setzt Defaults (role=repo, access=rw, isGit=true)", () => {
    const root = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
    });
    expect(root.id).toMatch(/^fsroot-/);
    expect(root.role).toBe("repo");
    expect(root.access).toBe("rw");
    expect(root.isGit).toBe(true);
    expect(root.githubRepoId).toBeNull();
    expect(root.createdAt).toBeGreaterThan(0);
  });

  it("list gibt alle Roots zurück, primary zuerst", () => {
    addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-web",
      role: "repo",
    });
    addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
      role: "primary",
    });
    const roots = listWorkspaceRoots(db, "ws-eh");
    expect(roots).toHaveLength(2);
    expect(roots[0].role).toBe("primary");
    expect(roots[0].absPath).toBe("/tmp/lazyos-test/demo-pv-crm");
  });

  it("roundtrip von access=ro + isGit=false + githubRepoId", () => {
    const root = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/docs-lib",
      role: "dir",
      access: "ro",
      isGit: false,
      githubRepoId: "wsrepo-123",
    });
    expect(root.access).toBe("ro");
    expect(root.isGit).toBe(false);
    expect(root.githubRepoId).toBe("wsrepo-123");
    expect(root.role).toBe("dir");

    const [reread] = listWorkspaceRoots(db, "ws-eh");
    expect(reread.access).toBe("ro");
    expect(reread.isGit).toBe(false);
    expect(reread.githubRepoId).toBe("wsrepo-123");
  });

  it("listet nur Roots des angefragten Workspace (Isolation)", () => {
    seedWorkspace("ws-other", "/tmp/lazyos-test/other");
    addWorkspaceRoot(db, { workspaceId: "ws-eh", absPath: "/a" });
    addWorkspaceRoot(db, { workspaceId: "ws-other", absPath: "/b" });
    expect(listWorkspaceRoots(db, "ws-eh")).toHaveLength(1);
    expect(listWorkspaceRoots(db, "ws-other")).toHaveLength(1);
  });
});

describe("fs-roots · mirrorPrimaryRoot (idempotent)", () => {
  beforeEach(() => seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm"));

  it("zweimaliger Aufruf → EINE Row, role=primary", () => {
    const first = mirrorPrimaryRoot(db, "ws-eh", "/tmp/lazyos-test/demo-pv-crm");
    const second = mirrorPrimaryRoot(db, "ws-eh", "/tmp/lazyos-test/demo-pv-crm");

    expect(first.role).toBe("primary");
    expect(second.role).toBe("primary");
    expect(second.id).toBe(first.id); // gleiche Row

    const roots = listWorkspaceRoots(db, "ws-eh");
    expect(roots).toHaveLength(1);
    expect(roots[0].role).toBe("primary");
  });

  it("upgradet eine bestehende role=repo-Row auf primary, ohne neue Row", () => {
    const repo = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
      role: "repo",
    });
    const mirrored = mirrorPrimaryRoot(db, "ws-eh", "/tmp/lazyos-test/demo-pv-crm");

    expect(mirrored.id).toBe(repo.id); // selbe Row
    expect(mirrored.role).toBe("primary");
    expect(listWorkspaceRoots(db, "ws-eh")).toHaveLength(1);
  });
});

describe("fs-roots · resolveWorkspaceRoots", () => {
  it("CRM + Web → primary + zwei rwRoots", () => {
    seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm");
    mirrorPrimaryRoot(db, "ws-eh", "/tmp/lazyos-test/demo-pv-crm");
    addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-web",
      role: "repo",
    });

    const resolved = resolveWorkspaceRoots(db, "ws-eh");
    expect(resolved.primary).toBe("/tmp/lazyos-test/demo-pv-crm");
    expect(resolved.roots).toHaveLength(2);
    expect(resolved.rwRoots).toHaveLength(2);
    expect(resolved.roRoots).toHaveLength(0);
  });

  it("trennt rw von ro", () => {
    seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm");
    addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
      role: "primary",
      access: "rw",
    });
    addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/shared-docs",
      role: "dir",
      access: "ro",
    });

    const resolved = resolveWorkspaceRoots(db, "ws-eh");
    expect(resolved.rwRoots).toHaveLength(1);
    expect(resolved.roRoots).toHaveLength(1);
    expect(resolved.roRoots[0].absPath).toBe("/tmp/lazyos-test/shared-docs");
  });

  it("Fallback ohne Rows → liest workspaces.path, roots=[]", () => {
    seedWorkspace("ws-legacy", "/tmp/lazyos-test/legacy-proj");
    const resolved = resolveWorkspaceRoots(db, "ws-legacy");
    expect(resolved.primary).toBe("/tmp/lazyos-test/legacy-proj");
    expect(resolved.roots).toHaveLength(0);
    expect(resolved.rwRoots).toHaveLength(0);
    expect(resolved.roRoots).toHaveLength(0);
  });

  it("Fallback spiegelt NICHT (read-only resolver)", () => {
    seedWorkspace("ws-legacy", "/tmp/lazyos-test/legacy-proj");
    resolveWorkspaceRoots(db, "ws-legacy");
    // Resolver darf KEINE Row angelegt haben.
    expect(listWorkspaceRoots(db, "ws-legacy")).toHaveLength(0);
  });

  it("Q1: Workspace mit leerem path + 0 Rows → primary='' , roots=[]", () => {
    seedWorkspace("ws-private", "");
    const resolved = resolveWorkspaceRoots(db, "ws-private");
    expect(resolved.primary).toBe("");
    expect(resolved.roots).toHaveLength(0);
  });

  it("unbekannter Workspace + 0 Rows → primary='' , roots=[]", () => {
    const resolved = resolveWorkspaceRoots(db, "ws-phantom");
    expect(resolved.primary).toBe("");
    expect(resolved.roots).toHaveLength(0);
  });
});

describe("fs-roots · remove", () => {
  beforeEach(() => seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm"));

  it("entfernt eine Row anhand der ID", () => {
    const root = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
    });
    expect(listWorkspaceRoots(db, "ws-eh")).toHaveLength(1);
    const result = removeWorkspaceRoot(db, root.id);
    expect(result.removed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(listWorkspaceRoots(db, "ws-eh")).toHaveLength(0);
  });

  it("entfernt einen repo-Root → removed:true (Row weg)", () => {
    const repo = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-web",
      role: "repo",
    });
    const result = removeWorkspaceRoot(db, repo.id);
    expect(result.removed).toBe(true);
    expect(listWorkspaceRoots(db, "ws-eh")).toHaveLength(0);
  });

  it("Primary-Root-Schutz: removed:false + primary_protected (Row bleibt)", () => {
    const primary = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
      role: "primary",
    });
    const result = removeWorkspaceRoot(db, primary.id);
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("primary_protected");
    // Defense-in-depth: die Row darf NICHT verschwunden sein.
    const roots = listWorkspaceRoots(db, "ws-eh");
    expect(roots).toHaveLength(1);
    expect(roots[0].id).toBe(primary.id);
    expect(roots[0].role).toBe("primary");
  });

  it("remove auf unbekannte ID → removed:false + not_found (kein Throw)", () => {
    expect(() => removeWorkspaceRoot(db, "fsroot-does-not-exist")).not.toThrow();
    const result = removeWorkspaceRoot(db, "fsroot-does-not-exist");
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("not_found");
  });
});

describe("fs-roots · updateWorkspaceRootAccess", () => {
  beforeEach(() => seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm"));

  it("rw → ro → rw Roundtrip + updated_at ändert sich", async () => {
    const root = addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
      access: "rw",
    });
    expect(root.access).toBe("rw");
    const createdUpdatedAt = root.updatedAt;

    // Date.now() hat ms-Granularität — kurz warten, damit updated_at messbar steigt.
    await new Promise((r) => setTimeout(r, 5));

    const toRo = updateWorkspaceRootAccess(db, root.id, "ro");
    expect(toRo).not.toBeNull();
    expect(toRo!.access).toBe("ro");
    expect(toRo!.id).toBe(root.id);
    expect(toRo!.role).toBe(root.role); // role unberührt
    expect(toRo!.absPath).toBe(root.absPath); // abs_path unberührt
    expect(toRo!.updatedAt).toBeGreaterThan(createdUpdatedAt);

    // Persistiert?
    expect(listWorkspaceRoots(db, "ws-eh")[0].access).toBe("ro");

    await new Promise((r) => setTimeout(r, 5));

    const backToRw = updateWorkspaceRootAccess(db, root.id, "rw");
    expect(backToRw).not.toBeNull();
    expect(backToRw!.access).toBe("rw");
    expect(backToRw!.updatedAt).toBeGreaterThan(toRo!.updatedAt);
    expect(listWorkspaceRoots(db, "ws-eh")[0].access).toBe("rw");
  });

  it("unbekannte id → null (kein Throw)", () => {
    expect(() =>
      updateWorkspaceRootAccess(db, "fsroot-does-not-exist", "ro"),
    ).not.toThrow();
    const result = updateWorkspaceRootAccess(db, "fsroot-does-not-exist", "ro");
    expect(result).toBeNull();
  });
});

describe("fs-roots · UNIQUE(workspace_id, abs_path)", () => {
  beforeEach(() => seedWorkspace("ws-eh", "/tmp/lazyos-test/demo-pv-crm"));

  it("zweimal derselbe (workspace, abs_path) via add → Conflict-Throw", () => {
    addWorkspaceRoot(db, {
      workspaceId: "ws-eh",
      absPath: "/tmp/lazyos-test/demo-pv-crm",
    });
    expect(() =>
      addWorkspaceRoot(db, {
        workspaceId: "ws-eh",
        absPath: "/tmp/lazyos-test/demo-pv-crm",
      }),
    ).toThrow(/UNIQUE|constraint/i);
  });

  it("derselbe abs_path in ZWEI Workspaces ist erlaubt", () => {
    seedWorkspace("ws-other", "/shared");
    addWorkspaceRoot(db, { workspaceId: "ws-eh", absPath: "/shared" });
    expect(() =>
      addWorkspaceRoot(db, { workspaceId: "ws-other", absPath: "/shared" }),
    ).not.toThrow();
  });
});
