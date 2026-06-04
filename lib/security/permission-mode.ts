/**
 * Permission-Mode Enforcer — Wave 1 / Batch 4 / ADR-0004.
 *
 * Implements `enforcePermission({ scope, toolClass, op })`:
 *   - When LAZYOS_PERMISSION_ENFORCEMENT === 'audit' (default, non-disruptive):
 *       always returns allow:true, writes one audit row (best-effort non-fatal).
 *   - When LAZYOS_PERMISSION_ENFORCEMENT === 'enforce':
 *       delegates to resolvePermission (lib-v1/permission/resolver) and may deny.
 *
 * N6:  Deterministic validators (resolvePermission) precede any symbolic reasoning.
 * N10: Every audit row carries a content_hash (sha256 of canonical JSON).
 * N8:  Audit rows are evidence — append-only, never updated.
 * N5:  User-correction-wins: external callers can force allow=true regardless of mode.
 *
 * Design note: lib-v1/permission/resolver.ts and repo.ts import from
 * lib-v1/permission/settings/schema.ts (PermissionMode).  Those modules require
 * a better-sqlite3 Database handle.  We call them only in 'enforce' mode where a
 * live DB handle is already available.  In 'audit' mode we write directly to
 * lazyos_permission_audit without going through the full resolver stack, keeping
 * the audit path independent of any resolver DB-fail risk.
 *
 * Import note: server/ has no @/ alias for lib-v1/, so resolver/repo are
 * imported via relative path from lib/security/ → ../../lib-v1/permission/*.
 * tsconfig "paths" covers @/* → ./* so both import styles are consistent with
 * the rest of the codebase.
 */

import { createHash } from 'node:crypto';
import { canonicalJSON } from '../../lib-v1/audit/canonical-json';
import type { ToolClass } from '../../lib-v1/permission/tool-class-map';
import type { PermissionMode } from '../../lib-v1/permission/settings/schema';
import { DEFAULT_PERMISSION_MODE } from '../../lib-v1/permission/settings/schema';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface PermissionScope {
  workspaceId: string;
  orgId?: string;
}

export interface EnforcePermissionArgs {
  scope: PermissionScope;
  toolClass: ToolClass;
  /** Verbatim tool-pattern / command — used for floor-class detection in enforce mode. */
  op: string;
  /** Tool name (e.g. "Bash", "Read", "mcp__foo__bar"). Used for audit and floor detection. */
  toolName?: string;
  /**
   * N5 override: if true, decision is forced allow regardless of mode.
   * Caller is responsible for recording why the override was granted.
   */
  userCorrectionOverride?: boolean;
}

export interface EnforceResult {
  /** Whether the operation is permitted. Always true in audit mode. */
  allow: boolean;
  /** The active permission mode at decision time. */
  mode: PermissionMode;
  /** Human-readable reason for the decision. */
  reason: string;
  /** sha256 content hash of the audit row written (N10). Empty string if audit write failed. */
  auditRowHash: string;
}

// ─────────────────────────────────────────────────────────────
// Feature flag
// ─────────────────────────────────────────────────────────────

/**
 * Returns the enforcement mode from the environment.
 *
 * 'audit'   (default) — log-only, never block. Non-disruptive (ADR-0004 Phase 1).
 * 'enforce'           — delegate to resolver; may deny based on workspace mode.
 */
export function getEnforcementMode(): 'audit' | 'enforce' {
  const v = (process.env.LAZYOS_PERMISSION_ENFORCEMENT ?? 'audit').toLowerCase().trim();
  return v === 'enforce' ? 'enforce' : 'audit';
}

// ─────────────────────────────────────────────────────────────
// Mode resolution (audit mode: reads lazyos_permission_modes directly)
// ─────────────────────────────────────────────────────────────

/**
 * Reads the active PermissionMode for a workspace from lazyos_permission_modes.
 * Falls back to DEFAULT_PERMISSION_MODE on any DB error (fail-open in audit mode,
 * consistent with ADR-0004: audit mode never blocks).
 *
 * In enforce mode callers should use resolvePermission (lib-v1) which has its
 * own DB read + floor-class check + allowlist lookup.  This function is the
 * lightweight read used for audit-mode annotation only.
 *
 * Note: lib-v1/permission/resolver.ts reads from `lazyos_permissions` (the
 * pre-existing Wave-0 table).  lazyos_permission_modes (0098) is the Wave-1
 * table from this migration.  In audit mode we only need a label; in enforce
 * mode the resolver has its own read path.
 */
function readWorkspaceMode(
  db: import('better-sqlite3').Database,
  workspaceId: string,
): PermissionMode {
  try {
    // Try the Wave-1 table first (0098_permission.sql).
    const row = db
      .prepare(`SELECT mode FROM lazyos_permission_modes WHERE workspace_id = ? LIMIT 1`)
      .get(workspaceId) as { mode: string } | undefined;
    if (row?.mode) {
      // Validate it's a known mode, fall back to default otherwise.
      const known = ['freerein', 'freerein-with-audit', 'lane', 'ask'] as const;
      type KnownMode = (typeof known)[number];
      if ((known as readonly string[]).includes(row.mode)) {
        return row.mode as KnownMode;
      }
    }
    // Fallback: try owner-default row.
    const defRow = db
      .prepare(`SELECT mode FROM lazyos_permission_modes WHERE workspace_id = 'owner-default' LIMIT 1`)
      .get() as { mode: string } | undefined;
    if (defRow?.mode) {
      const known = ['freerein', 'freerein-with-audit', 'lane', 'ask'] as const;
      if ((known as readonly string[]).includes(defRow.mode)) {
        return defRow.mode as PermissionMode;
      }
    }
  } catch {
    // Table may not exist yet (very early boot before migration).  Fail-open: use default.
  }
  return DEFAULT_PERMISSION_MODE;
}

// ─────────────────────────────────────────────────────────────
// Content-hash computation (N10)
// ─────────────────────────────────────────────────────────────

function computeAuditRowHash(row: Record<string, unknown>): string {
  // Strip DB-assigned fields that are not deterministic at write time.
  const STRIP = new Set(['id', 'content_hash', 'ts']);
  const stripped: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    if (STRIP.has(k)) continue;
    if (row[k] === undefined) continue;
    stripped[k] = row[k];
  }
  try {
    return createHash('sha256').update(canonicalJSON(stripped), 'utf8').digest('hex');
  } catch {
    // canonicalJSON should never throw for string/number/boolean fields, but be safe.
    return createHash('sha256').update(JSON.stringify(stripped), 'utf8').digest('hex');
  }
}

// ─────────────────────────────────────────────────────────────
// Audit row writer
// ─────────────────────────────────────────────────────────────

interface AuditWriteArgs {
  db: import('better-sqlite3').Database;
  scope: PermissionScope;
  toolClass: ToolClass;
  toolName: string;
  op: string;
  mode: PermissionMode;
  wouldAllow: boolean;
  reason: string;
  enforcement: 'audit' | 'enforce';
}

/**
 * Writes one append-only row to lazyos_permission_audit (N8/N10).
 * Returns the content_hash of the row written, or '' on failure.
 * NEVER throws — best-effort, non-fatal.
 */
function writeAuditRow(args: AuditWriteArgs): string {
  try {
    const rowPayload: Record<string, unknown> = {
      workspace_id: args.scope.workspaceId || null,
      org_id: args.scope.orgId ?? null,
      tool_class: args.toolClass,
      tool_name: args.toolName,
      op: args.op.slice(0, 2048),   // guard against huge commands
      mode: args.mode,
      would_allow: args.wouldAllow ? 1 : 0,
      reason: args.reason,
      enforcement: args.enforcement,
    };
    const content_hash = computeAuditRowHash(rowPayload);
    args.db
      .prepare(
        `INSERT INTO lazyos_permission_audit
           (workspace_id, org_id, tool_class, tool_name, op,
            mode, would_allow, reason, enforcement, content_hash)
         VALUES
           (@workspace_id, @org_id, @tool_class, @tool_name, @op,
            @mode, @would_allow, @reason, @enforcement, @content_hash)`,
      )
      .run({ ...rowPayload, content_hash });
    return content_hash;
  } catch (err) {
    // Table may not exist before migration runs (e.g., test env).  Best-effort,
    // but NOT silent (N8-observability, Security-Critic Finding 7): a dropped
    // audit row is an evidence gap and must be visible in the logs.
    // eslint-disable-next-line no-console
    console.warn('[permission-audit] write failed:', err);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────

/**
 * Enforce (or audit) a permission decision for a tool operation.
 *
 * @param db      better-sqlite3 Database handle (from getDb().$raw).
 * @param args    Operation context.
 * @returns       EnforceResult with allow:true guaranteed when enforcement='audit'.
 *
 * Non-disruptive guarantee:
 *   When LAZYOS_PERMISSION_ENFORCEMENT is absent or 'audit':
 *     - allow is ALWAYS true.
 *     - One audit row is written (best-effort).
 *     - No existing execution path is blocked.
 *
 * Enforce mode (LAZYOS_PERMISSION_ENFORCEMENT='enforce'):
 *   - Delegates to lib-v1/permission/resolver.resolvePermission.
 *   - May return allow:false for 'lane' or 'ask' modes that have no matching allowlist.
 *   - Floor-class patterns are always checked (orthogonal to mode).
 *   - FAIL-CLOSED (N6): if the resolver itself breaks (require failure, throw,
 *     missing migration) the result is allow:false — a broken enforcer must never
 *     silently pass ops through.
 *
 * N5 (user-correction-wins):
 *   - args.userCorrectionOverride=true forces allow:true regardless of mode + enforcement.
 *   - Audit row is still written with reason noting the override.
 */
export function enforcePermission(
  db: import('better-sqlite3').Database,
  args: EnforcePermissionArgs,
): EnforceResult {
  const enforcement = getEnforcementMode();
  const toolName = args.toolName ?? args.toolClass;

  // ── N5: user-correction-wins ──────────────────────────────
  if (args.userCorrectionOverride === true) {
    const mode = readWorkspaceMode(db, args.scope.workspaceId);
    const reason = 'N5-user-correction-override: forced allow';
    const hash = writeAuditRow({
      db,
      scope: args.scope,
      toolClass: args.toolClass,
      toolName,
      op: args.op,
      mode,
      wouldAllow: true,
      reason,
      enforcement,
    });
    return { allow: true, mode, reason, auditRowHash: hash };
  }

  // ── Audit mode (default, ADR-0004 Phase 1) ───────────────
  if (enforcement === 'audit') {
    const mode = readWorkspaceMode(db, args.scope.workspaceId);
    const reason = `audit-only: mode=${mode} enforcement=audit → allow without block (ADR-0004 Phase-1)`;
    const hash = writeAuditRow({
      db,
      scope: args.scope,
      toolClass: args.toolClass,
      toolName,
      op: args.op,
      mode,
      wouldAllow: true,
      reason,
      enforcement: 'audit',
    });
    return { allow: true, mode, reason, auditRowHash: hash };
  }

  // ── Enforce mode ─────────────────────────────────────────
  // Lazy-import to avoid pulling better-sqlite3 types transitively into
  // pure-logic test paths that don't have the module installed.
  //
  // Inline the resolver call here.  We cannot import from lib-v1/permission/resolver
  // at module-load time because resolver.ts uses a Database type from better-sqlite3
  // which may not be available in all test environments.  The dynamic require is
  // wrapped in try/catch so that a missing module degrades gracefully to audit-mode.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolvePermission } = require('../../lib-v1/permission/resolver') as {
      resolvePermission: typeof import('../../lib-v1/permission/resolver').resolvePermission;
    };

    const req: import('../../lib-v1/permission/resolver').PermissionRequest = {
      workspaceId: args.scope.workspaceId,
      toolClass: args.toolClass,
      toolName,
      toolPattern: args.op,
      actorKind: 'main-thread',
      actorId: 'system:permission-mode-enforcer',
    };

    const decision = resolvePermission(db, req);
    const allow = decision.decision === 'allow';
    const mode = decision.mode;
    const reason = decision.reason;

    const hash = writeAuditRow({
      db,
      scope: args.scope,
      toolClass: args.toolClass,
      toolName,
      op: args.op,
      mode,
      wouldAllow: allow,
      reason,
      enforcement: 'enforce',
    });

    return { allow, mode, reason, auditRowHash: hash };
  } catch (err) {
    // FAIL-CLOSED (N6, Security-Critic Finding 2): in enforce mode a broken
    // resolver (require() failure, resolver throw, missing migration) MUST NOT
    // silently allow everything — the whole point of the enforce flag is that
    // it actually enforces.  We deny, write an audit row with wouldAllow:false,
    // and surface the failure reason.  This branch is only reachable when
    // enforcement==='enforce' (audit mode returned earlier), so allow:false is
    // always the correct enforce-semantics here.
    // eslint-disable-next-line no-console
    console.warn('[permission-enforce] resolver failed — fail-closed deny:', err);
    const mode = readWorkspaceMode(db, args.scope.workspaceId);
    const reason = 'enforce-mode-resolver-failed: fail-closed deny';
    const hash = writeAuditRow({
      db,
      scope: args.scope,
      toolClass: args.toolClass,
      toolName,
      op: args.op,
      mode,
      wouldAllow: false,
      reason,
      enforcement: 'enforce',
    });
    return { allow: false, mode, reason, auditRowHash: hash };
  }
}

/**
 * Convenience overload: derives the DB handle from the module-level singleton.
 * Use when the caller does not have a raw DB handle available.
 *
 * Fallback semantics (consistent with enforcePermission, N6):
 *   - audit mode (default): getDb() failure is non-fatal → allow:true
 *     (preserves the non-disruptive Phase-1 guarantee).
 *   - enforce mode: getDb() failure is FAIL-CLOSED → allow:false, because an
 *     enforcing system that cannot reach its policy store must not pass ops
 *     through silently (Security-Critic Finding 2 follow-through).
 */
export function enforcePermissionFromSingleton(
  args: EnforcePermissionArgs,
): EnforceResult {
  try {
    // Dynamic require avoids circular dep risk (db/client → lib/security → db/client).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb } = require('../../db/client') as {
      getDb: () => import('../../db/client').LazyDb;
    };
    const db = getDb().$raw;
    return enforcePermission(db, args);
  } catch (err) {
    const enforcing = getEnforcementMode() === 'enforce';
    if (enforcing) {
      // eslint-disable-next-line no-console
      console.warn('[permission-enforce] DB unavailable — fail-closed deny:', err);
      return {
        allow: false,
        mode: DEFAULT_PERMISSION_MODE,
        reason: 'permission-singleton-unavailable: fail-closed deny (enforce mode)',
        auditRowHash: '',
      };
    }
    // Audit mode: DB not available (test env, early boot).  Non-fatal, non-disruptive.
    return {
      allow: true,
      mode: DEFAULT_PERMISSION_MODE,
      reason: 'permission-singleton-unavailable: allow (non-fatal, audit mode)',
      auditRowHash: '',
    };
  }
}
