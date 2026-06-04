// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-PERM-01 — PermissionRepo (Read-pfade auf 3 Permission-Tabellen + Insert-Pfade)
// Authority: modules/W1/M-PERM-01/PERMISSION-DDL.md §1-§3
//
// DDL already lives in migrations 0064-0066 (Phase-A). This module is the
// repository / writer-API.

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../audit/canonical-json';
import type { PermissionMode } from './settings/schema';

export type SetterIdentity = string; // 'user:<ulid>' | 'system:m-perm-05-backfill' | ...

export interface PermissionsRow {
  id: number;
  workspace_id: string;
  mode: PermissionMode;
  mode_old: PermissionMode | null;
  effective_since: string;
  set_by_user: SetterIdentity;
  reason: string | null;
  content_hash: string;
}

export interface AllowlistRow {
  id: number;
  created_at: string;
  workspace_id: string;
  tool_class: string;
  allowed_pattern: string;
  ttl_seconds: number | null;
  set_at: string;
  set_by: SetterIdentity;
  reason: string | null;
  content_hash: string;
}

export interface ChangeAuditRow {
  id: number;
  workspace_id: string;
  mode_old: PermissionMode | null;
  mode_new: PermissionMode;
  changed_at: string;
  changed_by: SetterIdentity;
  reason: string | null;
  two_factor_token_hash: string | null;
  content_hash: string;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Strip fields that the DDL fills in by default before hashing. */
function hashRow(row: Record<string, unknown>): string {
  const STRIP = new Set([
    'id',
    'content_hash',
    'effective_since',
    'set_at',
    'created_at',
    'changed_at',
  ]);
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (STRIP.has(k)) continue;
    if (row[k] === undefined) continue;
    stripped[k] = row[k];
  }
  return sha256Hex(canonicalJSON(stripped));
}

export class PermissionRepo {
  constructor(private readonly db: Database.Database) {}

  /** Lookup the active permission-row for a workspace; null if missing. */
  getPermission(workspaceId: string): PermissionsRow | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, mode, mode_old, effective_since,
                set_by_user, reason, content_hash
         FROM lazyos_permissions WHERE workspace_id = ?`,
      )
      .get(workspaceId) as PermissionsRow | undefined;
    return row ?? null;
  }

  /** Insert initial permissions-row. Backfill use-case (Tag-0). */
  insertPermission(args: {
    workspace_id: string;
    mode: PermissionMode;
    set_by_user: SetterIdentity;
    reason?: string;
  }): { id: number; content_hash: string } {
    const row = {
      workspace_id: args.workspace_id,
      mode: args.mode,
      mode_old: null,
      set_by_user: args.set_by_user,
      reason: args.reason ?? null,
    };
    const content_hash = hashRow(row);
    const result = this.db
      .prepare(
        `INSERT INTO lazyos_permissions
           (workspace_id, mode, mode_old, set_by_user, reason, content_hash)
         VALUES (@workspace_id, @mode, NULL, @set_by_user, @reason, @content_hash)`,
      )
      .run({
        workspace_id: row.workspace_id,
        mode: row.mode,
        set_by_user: row.set_by_user,
        reason: row.reason,
        content_hash,
      });
    return { id: Number(result.lastInsertRowid), content_hash };
  }

  /**
   * Update mode of a workspace. CALLER MUST:
   *   1. Already be inside a db.transaction()
   *   2. Have inserted the change-audit-row first (BEFORE-UPDATE trigger
   *      verifies same-TX existence within last 5 seconds).
   *
   * The Permissions-DDL §1 trigger enforces this in DB.
   */
  updateMode(args: {
    workspace_id: string;
    newMode: PermissionMode;
    oldMode: PermissionMode;
  }): void {
    if (!this.db.inTransaction) {
      throw new Error(
        'PermissionRepo.updateMode: caller MUST hold db.transaction (same-TX audit row required)',
      );
    }
    const result = this.db
      .prepare(
        `UPDATE lazyos_permissions
           SET mode = @newMode, mode_old = @oldMode, effective_since = datetime('now')
         WHERE workspace_id = @workspace_id`,
      )
      .run({
        workspace_id: args.workspace_id,
        newMode: args.newMode,
        oldMode: args.oldMode,
      });
    if (result.changes !== 1) {
      throw new Error(
        `PermissionRepo.updateMode: expected 1 row updated, got ${result.changes} for workspace_id=${args.workspace_id}`,
      );
    }
  }

  /** Insert change-audit row (N5/N8/N10). */
  insertChangeAudit(args: {
    workspace_id: string;
    mode_old: PermissionMode | null;
    mode_new: PermissionMode;
    changed_by: SetterIdentity;
    reason?: string;
    two_factor_token_hash?: string | null;
  }): { id: number; content_hash: string } {
    const row = {
      workspace_id: args.workspace_id,
      mode_old: args.mode_old,
      mode_new: args.mode_new,
      changed_by: args.changed_by,
      reason: args.reason ?? null,
      two_factor_token_hash: args.two_factor_token_hash ?? null,
    };
    const content_hash = hashRow(row);
    const result = this.db
      .prepare(
        `INSERT INTO lazyos_permission_change_audit
           (workspace_id, mode_old, mode_new, changed_by, reason,
            two_factor_token_hash, content_hash)
         VALUES
           (@workspace_id, @mode_old, @mode_new, @changed_by, @reason,
            @two_factor_token_hash, @content_hash)`,
      )
      .run({ ...row, content_hash });
    return { id: Number(result.lastInsertRowid), content_hash };
  }

  /** Read all active (non-expired, non-revoked) allowlist rows for a workspace+class. */
  listAllowlist(
    workspaceId: string,
    toolClass: string,
  ): AllowlistRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, workspace_id, tool_class, allowed_pattern,
                ttl_seconds, set_at, set_by, reason, content_hash
         FROM lazyos_permission_allowlist
         WHERE workspace_id = ? AND tool_class = ?`,
      )
      .all(workspaceId, toolClass) as AllowlistRow[];
    const now = Math.floor(Date.now() / 1000);
    return rows.filter((r) => {
      if (r.ttl_seconds === null) return true;
      // SQLite's datetime('now') returns 'YYYY-MM-DD HH:MM:SS' (UTC, no TZ).
      // Date.parse needs the explicit Z to treat it as UTC.
      const iso =
        /T/.test(r.set_at) ? r.set_at : r.set_at.replace(' ', 'T') + 'Z';
      const setAtSec = Math.floor(Date.parse(iso) / 1000);
      if (Number.isNaN(setAtSec)) return true; // can't parse → keep
      return setAtSec + r.ttl_seconds > now;
    });
  }

  /** Insert new allowlist row (write-once). */
  insertAllowlist(args: {
    workspace_id: string;
    tool_class: string;
    allowed_pattern: string;
    ttl_seconds?: number | null;
    set_by: SetterIdentity;
    reason?: string;
  }): { id: number; content_hash: string } {
    const row = {
      workspace_id: args.workspace_id,
      tool_class: args.tool_class,
      allowed_pattern: args.allowed_pattern,
      ttl_seconds: args.ttl_seconds ?? null,
      set_by: args.set_by,
      reason: args.reason ?? null,
    };
    const content_hash = hashRow(row);
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO lazyos_permission_allowlist
           (workspace_id, tool_class, allowed_pattern, ttl_seconds,
            set_by, reason, content_hash)
         VALUES
           (@workspace_id, @tool_class, @allowed_pattern, @ttl_seconds,
            @set_by, @reason, @content_hash)`,
      )
      .run({ ...row, content_hash });
    return { id: Number(result.lastInsertRowid), content_hash };
  }
}
