/**
 * Phase MU.5 — Effective-Role-Resolution + Permission-Checks.
 *
 * A central place for the question "may user X do this in workspace Y?".
 *
 * Inheritance rule (mirroring memberships.ts):
 *   1. If a `workspace_memberships` row exists AND inheritsFromOrg=false:
 *      this role applies directly.
 *   2. Otherwise: the workspace belongs to an org → org_memberships.role applies.
 *   3. Workspace without org AND without workspace_membership:
 *      → legacy solo mode. If the user is the **only** active user,
 *      they count as implicitly founder. Otherwise → no access.
 *
 * Role hierarchy (higher = more rights):
 *   founder > admin > member > viewer > guest
 *
 * Nutzung:
 *   const role = getEffectiveWorkspaceRole(userId, wsId);
 *   if (!canEditWorkspaceContent(role)) return forbidden();
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import {
  orgMemberships,
  workspaceMemberships,
  type MembershipRole,
} from "@/db/schema/memberships";
import { workspaces } from "@/db/schema/workspaces";

const ROLE_RANK: Record<MembershipRole, number> = {
  founder: 5,
  admin: 4,
  member: 3,
  viewer: 2,
  guest: 1,
};

export type EffectiveRole = MembershipRole | "solo-implicit-founder" | null;

const SOLO_RANK = ROLE_RANK.founder;

function rankOf(role: EffectiveRole): number {
  if (role === null) return 0;
  if (role === "solo-implicit-founder") return SOLO_RANK;
  return ROLE_RANK[role];
}

/**
 * Returns the effective role of a user in a workspace, or null
 * if no membership is derivable.
 */
export function getEffectiveWorkspaceRole(
  userId: string,
  workspaceId: string,
): EffectiveRole {
  const db = getDb();

  // 1. Workspace-direkte Membership (override)
  const wsMem = db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .all();
  if (wsMem.length > 0 && !wsMem[0].inheritsFromOrg) {
    return wsMem[0].role as MembershipRole;
  }

  // 2. Workspace → Org → org_membership
  const ws = db
    .select({ organizationId: workspaces.organizationId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1)
    .all();
  if (ws.length === 0) return null;
  const orgId = ws[0].organizationId;
  if (orgId) {
    const orgMem = db
      .select()
      .from(orgMemberships)
      .where(
        and(
          eq(orgMemberships.userId, userId),
          eq(orgMemberships.orgId, orgId),
        ),
      )
      .limit(1)
      .all();
    if (orgMem.length > 0) {
      return orgMem[0].role as MembershipRole;
    }
    // User is not in the org — no access (even if a ws-membership
    // with inherits=true exists; that would be a data error).
    if (wsMem.length > 0) {
      return wsMem[0].role as MembershipRole;
    }
    return null;
  }

  // 3. Workspace without org, without workspace-membership → legacy solo mode.
  // We are in a single-user phase: if only one active user exists at all,
  // they are treated as implicitly founder.
  const activeUserCount = db.$raw
    .prepare(
      "SELECT COUNT(*) as c FROM users WHERE status = 'active' AND deleted_at IS NULL",
    )
    .get() as { c?: number } | undefined;
  if ((activeUserCount?.c ?? 0) <= 1) {
    return "solo-implicit-founder";
  }

  // Multi-user + workspace without org → no implicit access. Must be unlocked
  // via workspace_memberships first.
  if (wsMem.length > 0) return wsMem[0].role as MembershipRole;
  return null;
}

/** ≥ member may edit content (notes, description, tickets). */
export function canEditWorkspaceContent(role: EffectiveRole): boolean {
  return rankOf(role) >= ROLE_RANK.member;
}

/** ≥ admin may change structure (org link, members, permissions). */
export function canManageWorkspaceStructure(role: EffectiveRole): boolean {
  return rankOf(role) >= ROLE_RANK.admin;
}

/** ≥ viewer may read. */
export function canReadWorkspace(role: EffectiveRole): boolean {
  return rankOf(role) >= ROLE_RANK.viewer;
}

/** Readable label for UI/audit. */
export function describeRole(role: EffectiveRole): string {
  if (role === null) return "kein Zugriff";
  if (role === "solo-implicit-founder") return "Solo-Owner";
  return role;
}
