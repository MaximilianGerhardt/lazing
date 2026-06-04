-- ============================================================
-- 0078_lint_override_audit_v2.sql — Slice-B M-POL-01
-- ALTER lazyos_lint_override_audit ADD rule_version (additive).
-- Authority: modules/W2/M-POL-01/LINT-V2-SPEC.md §5.2
--            MIGRATION-NUMBERING-LEDGER.md §3.2 (renumbered from 0067-additive)
--
-- The base lazyos_lint_override_audit table is part of Slice-A M9 (Tabelle #5).
-- For Phase-A bootstrap we CREATE-IF-NOT-EXISTS the base schema first, then
-- ALTER ADD COLUMN rule_version. Both statements are idempotent.
-- ============================================================

-- Base schema (Slice-A M9 #5) — created here if missing (bootstrap-friendly).
CREATE TABLE IF NOT EXISTS lazyos_lint_override_audit (
  id            TEXT PRIMARY KEY,
  override_kind TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  line          INTEGER NOT NULL,
  author_email  TEXT NOT NULL,
  reason        TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Additive v2 column. SQLite does not support ADD COLUMN IF NOT EXISTS, so the
-- migration runner gates this on PRAGMA user_version < 78 (handled in
-- scripts/migrate.ts). Once applied, re-runs are no-op.
-- For SQLite, ALTER TABLE ADD COLUMN with default NULL is safe + idempotent
-- if guarded by the runner; if re-applied, SQLite throws "duplicate column" —
-- so we wrap by selecting from pragma_table_info via runner pre-check.
ALTER TABLE lazyos_lint_override_audit ADD COLUMN rule_version TEXT NOT NULL DEFAULT '0.2.0-slice-b';
