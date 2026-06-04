// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Maximilian Gerhardt
//
// M-PERM-02 — Permission-Inheritance-Resolver
// Authority: modules/W1/M-PERM-02/RESOLVER-MODUL-SPEC.md (verbatim)
//
// Single source of truth for: "may actor X execute tool-class T pattern P
// against workspace W?"

import type Database from 'better-sqlite3';
import { detectFloorClass, type FloorClass } from './floor-patterns';
import {
  OWNER_DEFAULT_WORKSPACE_ID,
} from './constants';
import type { ToolClass } from './tool-class-map';
import type { PermissionMode } from './settings/schema';

export type PolicyToolClass = ToolClass;

export type DenyCode =
  | 'floor-class-block'
  | 'no-allowlist-match'
  | 'parent-narrower'
  | 'db-fail-closed'
  | 'two-factor-required'
  | 'override-revoked';

export interface PermissionRequest {
  workspaceId: string;
  toolClass: PolicyToolClass;
  toolName: string;
  toolPattern: string;
  actorKind: 'user' | 'subagent' | 'main-thread' | 'system';
  actorId: string;
  requestContext?: {
    cwd?: string;
    workstreamId?: string;
    parentSpawnMode?: PermissionMode;
    bundleId?: string;
    bridge_approval_id?: string;
  };
}

export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  mode: PermissionMode;
  reason: string;
  audit_required: boolean;
  bridge_required: boolean;
  deny_code?: DenyCode;
  floor_class?: FloorClass;
  floor_override_used?: boolean;
}

/** Strictness rank: higher = stricter. */
const MODE_STRICTNESS_RANK: Record<PermissionMode, number> = {
  freerein: 0,
  'freerein-with-audit': 1,
  lane: 2,
  ask: 3,
};

/** Glob-pattern match against a tool-pattern. Supports * wildcards. */
function globMatchPattern(pattern: string, target: string): boolean {
  // Convert pattern to regex.
  // Escape regex metachars except '*' which becomes '.*'.
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*') +
      '$',
  );
  return re.test(target);
}

/** Detect cross-workspace DB-writes (heuristic V1). */
function isCrossWorkspace(req: PermissionRequest): boolean {
  if (req.toolClass !== 'db') return false;
  // Look for workspace_id literal not matching the caller's WS.
  const ownWs = req.workspaceId;
  const m = req.toolPattern.match(/workspace_id\s*=\s*['"]?([^'"\s)]+)/);
  if (m && m[1] !== ownWs) return true;
  return false;
}

/**
 * Main API. Resolves a permission request. NEVER throws.
 *
 * Postcondition: returns a typed PermissionDecision. On DB-fail, returns
 * `decision='deny'` with `deny_code='db-fail-closed'` and
 * `audit_required=true`.
 */
export function resolvePermission(
  db: Database.Database,
  req: PermissionRequest,
): PermissionDecision {
  let row: { mode: PermissionMode } | undefined;

  // Step 1 — Read workspace-mode
  let mode: PermissionMode;
  try {
    const lookupMode = db.prepare(
      `SELECT mode FROM lazyos_permissions WHERE workspace_id = ?`,
    );
    row = lookupMode.get(req.workspaceId) as { mode: PermissionMode } | undefined;

    if (!row) {
      if (process.env.LAZYOS_MULTI_TENANT === '1') {
        return {
          decision: 'deny',
          mode: 'ask',
          deny_code: 'db-fail-closed',
          reason: `multi-tenant mode active but workspace '${req.workspaceId}' not in lazyos_permissions`,
          audit_required: true,
          bridge_required: false,
        };
      }
      row = lookupMode.get(OWNER_DEFAULT_WORKSPACE_ID) as
        | { mode: PermissionMode }
        | undefined;
      if (!row) {
        return {
          decision: 'deny',
          mode: 'ask',
          deny_code: 'db-fail-closed',
          reason: `owner-default workspace row missing — m-perm-05 backfill incomplete (lookup-trace: requested='${req.workspaceId}', fallback='${OWNER_DEFAULT_WORKSPACE_ID}')`,
          audit_required: true,
          bridge_required: false,
        };
      }
    }
    mode = row.mode;
  } catch (err) {
    return {
      decision: 'deny',
      mode: 'ask',
      deny_code: 'db-fail-closed',
      reason: `DB-error during mode-read: ${(err as Error).message}`,
      audit_required: true,
      bridge_required: false,
    };
  }

  // Step 2 — Floor-class check (orthogonal to mode)
  const toolForFloor = mapToolNameForFloor(req.toolName);
  const floor = detectFloorClass(
    toolForFloor,
    req.toolPattern,
    req.requestContext?.cwd,
    req.requestContext?.cwd,
  );
  if (floor !== null) {
    if (
      floor === 'secret-read' &&
      req.actorKind === 'user' &&
      req.requestContext?.bundleId
    ) {
      // §4 N5-User-Override path — V1 stub: deny with two-factor-required
      // unless caller has already gone through bridge-approval. Real M6
      // resolvePriority delegation happens via bridge-approval module.
      return {
        decision: 'deny',
        mode,
        deny_code: 'two-factor-required',
        reason: `floor-class=secret-read; bundleId=${req.requestContext.bundleId} present but no TOTP-consume token (delegate to bridge-approval)`,
        audit_required: true,
        bridge_required: true,
        floor_class: floor,
      };
    }
    return {
      decision: 'deny',
      mode,
      deny_code:
        floor === 'secret-read' ? 'two-factor-required' : 'floor-class-block',
      reason: `floor-class=${floor} hit on toolPattern=${req.toolPattern}`,
      audit_required: true,
      bridge_required: false,
      floor_class: floor,
    };
  }

  // Step 3 — Mode-branch
  let decision: PermissionDecision;
  switch (mode) {
    case 'freerein-with-audit':
      decision = {
        decision: 'allow',
        mode,
        audit_required: true,
        bridge_required: false,
        reason: 'Q1 Phase-1 diagnose mode (freerein-with-audit)',
      };
      break;
    case 'freerein':
      if (isCrossWorkspace(req)) {
        decision = {
          decision: 'ask',
          mode,
          audit_required: true,
          bridge_required: true,
          reason: 'cross-workspace-db-write hardcoded-bridge',
        };
      } else {
        decision = {
          decision: 'allow',
          mode,
          audit_required: false,
          bridge_required: false,
          reason: 'freerein mode allows without audit',
        };
      }
      break;
    case 'lane': {
      const matched = lookupAllowlist(db, req.workspaceId, req.toolClass).find(
        (p) => globMatchPattern(p, req.toolPattern),
      );
      if (matched) {
        decision = {
          decision: 'allow',
          mode,
          audit_required: true,
          bridge_required: false,
          reason: `lane allow: pattern '${matched}' matched`,
        };
      } else {
        decision = {
          decision: 'deny',
          mode,
          deny_code: 'no-allowlist-match',
          audit_required: true,
          bridge_required: false,
          reason: `lane mode: no allowlist pattern matched toolPattern=${req.toolPattern} toolClass=${req.toolClass}`,
        };
      }
      break;
    }
    case 'ask': {
      const matched = lookupAllowlist(db, req.workspaceId, req.toolClass).find(
        (p) => globMatchPattern(p, req.toolPattern),
      );
      if (matched) {
        decision = {
          decision: 'allow',
          mode,
          audit_required: true,
          bridge_required: false,
          reason: `ask mode: allowlist pattern '${matched}' matched`,
        };
      } else {
        decision = {
          decision: 'ask',
          mode,
          audit_required: true,
          bridge_required: true,
          reason: 'no-allowlist-match user-approval-needed',
        };
      }
      break;
    }
  }

  // Step 4 — Cross-spawn-inheritance check
  if (req.requestContext?.parentSpawnMode !== undefined) {
    const childRank = MODE_STRICTNESS_RANK[mode];
    const parentRank = MODE_STRICTNESS_RANK[req.requestContext.parentSpawnMode];
    if (childRank < parentRank) {
      return {
        decision: 'deny',
        mode,
        deny_code: 'parent-narrower',
        audit_required: true,
        bridge_required: false,
        reason: `child mode '${mode}' more permissive than parent '${req.requestContext.parentSpawnMode}'`,
      };
    }
  }

  return decision;
}

function lookupAllowlist(
  db: Database.Database,
  workspaceId: string,
  toolClass: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT allowed_pattern, ttl_seconds, set_at FROM lazyos_permission_allowlist
       WHERE workspace_id = ? AND tool_class = ?`,
    )
    .all(workspaceId, toolClass) as Array<{
    allowed_pattern: string;
    ttl_seconds: number | null;
    set_at: string;
  }>;
  const now = Math.floor(Date.now() / 1000);
  const active = rows.filter((r) => {
    if (r.ttl_seconds === null) return true;
    const setAtSec = Math.floor(Date.parse(r.set_at) / 1000);
    return setAtSec + r.ttl_seconds > now;
  });
  return active.map((r) => r.allowed_pattern);
}

/** Map tool-name into floor-class detector's tool dimension. */
function mapToolNameForFloor(
  toolName: string,
): 'Bash' | 'Edit' | 'Write' | 'Read' | 'DB' {
  if (toolName === 'Bash' || toolName === 'BashOutput' || toolName === 'CLI')
    return 'Bash';
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit')
    return 'Edit';
  if (toolName === 'Write') return 'Write';
  if (toolName === 'Read') return 'Read';
  if (toolName === 'DB' || toolName === 'SQLite') return 'DB';
  return 'Bash'; // default falls back to Bash (most permissive detector applies)
}
