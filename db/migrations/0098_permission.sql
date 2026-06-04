-- ============================================================
-- 0098_permission.sql — Permission-Foundation (Wave 1 / Batch 4)
--
-- Datum:  2026-05-24
-- Autor:  Claude Code (Permission-Foundation sprint, Task #48 Batch4)
-- ADR:    docs/adr/0004-default-permission-mode.md
-- POS-1:  End-state default = 'lane'; Phase-1 = 'freerein-with-audit'.
-- N10:    Every row carries a content_hash (sha256 over canonical JSON).
-- N8:     Audit is evidence, not telemetry — append-only, no UPDATE/DELETE.
--
-- Tables created:
--   lazyos_permission_modes        — workspace/org-scoped mode assignment
--   lazyos_permission_audit        — append-only op decision log (N10/N8)
--
-- Enforcement note (ADR-0004 §Phase 1):
--   LAZYOS_PERMISSION_ENFORCEMENT default = 'audit' → only logs, never blocks.
--   Enforcement is toggled externally via ENV; this migration is data-only.
--
-- Idempotent: all statements use CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. lazyos_permission_modes
--    Workspace-scoped (or org-scoped) mode assignment.
--    One row per workspace; org-level row uses org_id + NULL workspace_id.
--    On conflict (duplicate workspace_id) we do NOTHING — caller must UPDATE
--    via PermissionRepo.updateMode to maintain the change-audit trail.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazyos_permission_modes (
  id              INTEGER  PRIMARY KEY AUTOINCREMENT,
  workspace_id    TEXT     UNIQUE,                       -- NULL iff org-level row
  org_id          TEXT,                                  -- NULL iff workspace-level row
  mode            TEXT     NOT NULL DEFAULT 'freerein-with-audit'
                           CHECK (mode IN ('freerein','freerein-with-audit','lane','ask')),
  effective_since TEXT     NOT NULL DEFAULT (datetime('now')),
  set_by          TEXT     NOT NULL DEFAULT 'system:0098-migration',
  reason          TEXT,
  content_hash    TEXT     NOT NULL DEFAULT ''           -- filled by application layer (N10)
);

CREATE INDEX IF NOT EXISTS idx_perm_modes_workspace
  ON lazyos_permission_modes (workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_perm_modes_org
  ON lazyos_permission_modes (org_id)
  WHERE org_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
-- 2. lazyos_permission_audit
--    Append-only log of every permission decision.
--    Rows are NEVER updated or deleted (N8 audit-as-evidence).
--    Floor-class patterns in floor-patterns.ts guard against
--    tampering with this table (audit-tampering FloorClass).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lazyos_permission_audit (
  id           INTEGER  PRIMARY KEY AUTOINCREMENT,
  ts           TEXT     NOT NULL DEFAULT (datetime('now')),
  workspace_id TEXT,                                   -- may be NULL for system ops
  org_id       TEXT,
  tool_class   TEXT     NOT NULL,                      -- ToolClass: fs-read / shell / ...
  tool_name    TEXT     NOT NULL DEFAULT '',
  op           TEXT     NOT NULL DEFAULT '',           -- tool_pattern / command
  mode         TEXT     NOT NULL,                      -- the active mode at decision time
  would_allow  INTEGER  NOT NULL CHECK (would_allow IN (0,1)),
  reason       TEXT     NOT NULL DEFAULT '',
  enforcement  TEXT     NOT NULL DEFAULT 'audit'
               CHECK (enforcement IN ('audit','enforce')),
  content_hash TEXT     NOT NULL DEFAULT ''            -- sha256(canonical-JSON row) (N10)
);

-- Index for workspace-scoped queries (analytics, pattern-derive).
CREATE INDEX IF NOT EXISTS idx_perm_audit_workspace_ts
  ON lazyos_permission_audit (workspace_id, ts);

-- Index for tool-class analytics (phase-2 allowlist derivation).
CREATE INDEX IF NOT EXISTS idx_perm_audit_tool_class
  ON lazyos_permission_audit (tool_class, ts);

-- ─────────────────────────────────────────────────────────────
-- 3. Backfill: seed the owner-default workspace with phase-1 mode.
--    Safe on empty DB (row didn't exist yet) and idempotent on re-run
--    (INSERT OR IGNORE skips duplicate workspace_id).
--
-- N10 content_hash note (Security-Critic Finding 5):
--    SQLite ships no sha256() built-in, so the canonical N10 hash (sha256 over
--    canonical-JSON, see lib-v1/audit/canonical-json.ts) CANNOT be computed in
--    pure SQL at migration time without an extension. Rather than leave the
--    column empty (an N10 gap), we stamp a deterministic, self-describing
--    bootstrap sentinel. The application owns the real hash: the first mutation
--    of this row through PermissionRepo.updateMode (lib-v1/permission/repo.ts)
--    recomputes content_hash via hashRow() and overwrites the sentinel. The
--    sentinel is distinguishable from both a missing/empty hash and a real
--    64-char sha256 hex, so an N10 verifier can flag "still-bootstrap" rows.
-- ─────────────────────────────────────────────────────────────
-- Security-Critic CRITICAL #1 (2026-05-25) — defense-in-depth:
--   The owner-default seed is set to 'ask' (the LEAST-granting mode) so that
--   IF this row is ever read as a fallback (it should NOT be — see
--   readWorkspacePermissionMode which no longer falls back), it grants NO tools.
--   Tool grants now require an explicit per-workspace row set via the PATCH route.
INSERT OR IGNORE INTO lazyos_permission_modes
  (workspace_id, mode, set_by, reason, content_hash)
VALUES
  ('owner-default',
   'ask',
   'system:0098-migration',
   'ADR-0004 bootstrap (ask = least-granting; no fallback grant — Security-Critic CRITICAL #1)',
   'bootstrap:0098:owner-default:ask');
