/**
 * Shared Membership-Gating Helper (Security-Critic P0-C1, 2026-05-25).
 *
 * Problem: in the org-less single-user case, `getEffectiveWorkspaceRole`
 * returns `'solo-implicit-founder'` — an implicit bootstrap fallback without
 * a real membership proof. In a multi-user setup (example company +
 * clients), an authenticated user could access foreign credentials via a body
 * `workspaceId` that falls into the solo pattern (read AND write path).
 *
 * Rule for sensitive credential operations: require PROVEN membership —
 * i.e. access must be justified by a REAL membership:
 *   (A) an explicit workspace_memberships row (userId + workspaceId), OR
 *   (B) an org_memberships row for the org the workspace belongs to.
 *
 * `solo-implicit-founder` alone is NOT enough. It is an implicit
 * bootstrap fallback, not a proof of membership.
 *
 * This module is used by:
 *   - app/api/connectors/[provider]/credential/route.ts (write gate, Security-Critic 2a)
 *   - lib/credentials/vault.ts (org-fallback read gate, Security-Critic P0-C1)
 *
 * NO duplicate of the logic — a single, tested implementation.
 *
 * N8: audit rows are written by the caller (vault / route) — this helper only returns a boolean.
 * N9: scope anchor explicitly via workspaceId + org lookup.
 */

import { and, eq } from "drizzle-orm";

import { getDb } from "@/db/client";
import { workspaceMemberships } from "@/db/schema/memberships";
import { findOrgForWorkspace, findUserOrgMembership } from "@/lib/orgs/repo";

/**
 * Returns true if userId has PROVEN membership in workspaceId:
 *   (A) explicit workspace_memberships row for (userId, workspaceId), OR
 *   (B) org_memberships row for the workspace's org.
 *
 * `solo-implicit-founder` alone (no workspace/org row) → false.
 *
 * Never throws exceptions — on DB errors fail-closed (false).
 */
export function hasRealWorkspaceMembership(
  userId: string,
  workspaceId: string,
): boolean {
  try {
    const db = getDb();

    // (A) Explicit workspace_memberships row?
    const wsMem = db
      .select({ id: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.userId, userId),
          eq(workspaceMemberships.workspaceId, workspaceId),
        ),
      )
      .limit(1)
      .all();
    if (wsMem.length > 0) return true;

    // (B) Org membership for the workspace's org?
    const org = findOrgForWorkspace(workspaceId);
    if (org && findUserOrgMembership(userId, org.id) !== null) return true;

    // Neither explicit WS nor org membership → only solo-implicit-founder etc.
    // NOT sufficient for sensitive credential operations.
    return false;
  } catch {
    // Fail-closed: database error → no access.
    return false;
  }
}
