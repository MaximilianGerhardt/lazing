-- ============================================================
-- 0111_workspace_fs_roots.sql — Slice FS-1 (Workspace-Isolation-Modell)
--
-- Schließt die Kern-Lücke aus dem Design-Doc
-- (docs/plans/2026-05-26_workspace-isolation-model.md §1.4):
-- Ein Workspace hatte bisher GENAU EINEN Pfad (workspaces.path single-valued).
-- Die Owner-Direktive verlangt: ein Workspace = 1..n Repos/Verzeichnisse
-- (z.B. Demo PV = CRM-Git + Website-Git = EIN Workspace).
--
-- Diese Tabelle ist die Workspace-Path-Registry (§4.1). Jede Row ist ein
-- lokaler FS-Root (echter Mac-Pfad, z.B. <workspace-dir>), den
-- der Executor/die Sandbox als Scope-Grenze nutzen darf.
--
-- - `workspaces.path` bleibt als Primary-Root (Rückwärtskompat) — wird per
--   mirrorPrimaryRoot() als erste Row mit role='primary' gespiegelt.
-- - `access` erlaubt read-only-Roots (z.B. Doku-Bibliothek nur lesen).
-- - `github_repo_id` ist ein OPTIONALER Soft-FK auf workspace_github_repos.id
--   (REMOTE-Koordinaten), NICHT als echte FK erzwungen (die Tabelle ist
--   N:1 remote-only und kann fehlen).
--
-- SQLite-Idempotenz: CREATE TABLE/INDEX IF NOT EXISTS (Konvention wie
-- 0076_bridges.sql). Timestamps sind INTEGER (ms). IDs sind TEXT.
-- CHECK-Constraints inline (bei CREATE TABLE erlaubt — siehe 0076).
-- ============================================================
CREATE TABLE IF NOT EXISTS workspace_fs_roots (
  id              TEXT    PRIMARY KEY NOT NULL,
  workspace_id    TEXT    NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  abs_path        TEXT    NOT NULL,                 -- z.B. <workspace-dir>
  role            TEXT    NOT NULL DEFAULT 'repo',  -- 'primary' | 'repo' | 'dir'
  access          TEXT    NOT NULL DEFAULT 'rw',    -- 'ro' | 'rw'
  is_git          INTEGER NOT NULL DEFAULT 1,       -- 1 wenn eigenes Git-Repo
  github_repo_id  TEXT,                             -- optionaler Soft-FK auf workspace_github_repos.id
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,

  UNIQUE(workspace_id, abs_path),
  CHECK (role   IN ('primary', 'repo', 'dir')),
  CHECK (access IN ('ro', 'rw'))
);

CREATE INDEX IF NOT EXISTS idx_ws_fs_roots_ws
  ON workspace_fs_roots(workspace_id);
