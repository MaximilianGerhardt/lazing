/**
 * Org-Authorization-Helper (Phase ORG SP-5).
 *
 * `assertOrgRole(req, orgId, minRole)` looks up the user from the request,
 * checks their role in this org, and throws `OrgAuthError` if
 * below the minimum role.
 *
 * Role order (from least to most power):
 *   guest < viewer < member < admin < founder
 */

import type { MembershipRole } from "@/db/schema/memberships";
import type { RequestLike } from "@/lib/security/subject";
import { currentUserIdResolved } from "@/lib/security/subject-server";

import { findUserOrgMembership } from "./repo";

const ROLE_ORDER: MembershipRole[] = [
  "guest",
  "viewer",
  "member",
  "admin",
  "founder",
];

export class OrgAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "auth-required"
      | "not-member"
      | "insufficient-role"
      | "user-bootstrap",
  ) {
    super(message);
    this.name = "OrgAuthError";
  }
}

export interface OrgAuthOk {
  userId: string;
  role: MembershipRole;
}

/**
 * Throws OrgAuthError on any failure. Returns OrgAuthOk when
 * the current user has at least `minRole` in the org.
 */
export function assertOrgRole(
  req: RequestLike,
  orgId: string,
  minRole: MembershipRole,
): OrgAuthOk {
  const userId = currentUserIdResolved(req);
  if (!userId) {
    throw new OrgAuthError(
      "Login erforderlich oder kein Founder vorhanden.",
      "auth-required",
    );
  }
  const membership = findUserOrgMembership(userId, orgId);
  if (!membership) {
    throw new OrgAuthError(
      `Du bist kein Mitglied von Org ${orgId}.`,
      "not-member",
    );
  }
  const userRoleIdx = ROLE_ORDER.indexOf(membership.role as MembershipRole);
  const minRoleIdx = ROLE_ORDER.indexOf(minRole);
  if (userRoleIdx < 0 || minRoleIdx < 0 || userRoleIdx < minRoleIdx) {
    throw new OrgAuthError(
      `Rolle '${membership.role}' reicht nicht — benötigt: ${minRole}.`,
      "insufficient-role",
    );
  }
  return {
    userId,
    role: membership.role as MembershipRole,
  };
}

export function orgAuthErrorToHttp(err: OrgAuthError): {
  status: number;
  body: { error: string; message: string };
} {
  switch (err.code) {
    case "auth-required":
      return { status: 401, body: { error: err.code, message: err.message } };
    case "user-bootstrap":
      return { status: 401, body: { error: err.code, message: err.message } };
    case "not-member":
    case "insufficient-role":
      return { status: 403, body: { error: err.code, message: err.message } };
  }
}
