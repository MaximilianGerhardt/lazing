/**
 * Token resolution for GitHub operations in the workspace context.
 *
 * Priority:
 *   1. Org token — when the workspace is assigned to an org AND the org
 *      has an `org_github_credentials` row.
 *   2. User token — fallback to the user's `github_credentials` (existing
 *      path for org-less workspaces or orgs without a GitHub connection).
 *   3. null — no GitHub connection present.
 *
 * Server-only. NEVER write the token to logs or HTTP responses.
 */

import { decryptOrgToken } from "@/lib/github/org-repo";
import { findCredentialForUser } from "@/lib/github/repo";
import { decryptGithubToken } from "@/lib/github/client";
import { findOrgForWorkspace } from "@/lib/orgs/repo";

export interface ResolvedToken {
  token: string;
  /** 'org' when the org token is used, 'user' on the user-token fallback. */
  source: "org" | "user";
}

/**
 * Resolves the GitHub token to use for a workspace context.
 *
 * Isolation invariant:
 *   - The org token is only used when `findOrgForWorkspace` returns an org for
 *     the workspace AND `decryptOrgToken(orgId)` returns a token.
 *   - A user who is NOT a member of the associated org must not reach this
 *     endpoint at all (caller's duty: auth check before the call).
 *   - The caller must NEVER write the returned token to the response body
 *     or logs.
 *
 * @param workspaceId  ID of the workspace (from the URL param `[id]`).
 * @param userId       ID of the authenticated user (currentUserIdResolved).
 * @returns ResolvedToken or null when no connection is present.
 */
export function resolveGithubTokenForWorkspace(
  workspaceId: string,
  userId: string,
): ResolvedToken | null {
  // Step 1: check whether the workspace is assigned to an org.
  const org = findOrgForWorkspace(workspaceId);

  if (org) {
    // Step 2: check whether the org has a GitHub token.
    // "token-resolver" as the N8 purpose for the audit row.
    const orgToken = decryptOrgToken(org.id, "token-resolver");
    if (orgToken) {
      return { token: orgToken, source: "org" };
    }
  }

  // Step 3: fallback to the user token (backward-compat for org-less workspaces
  // and orgs without a GitHub connection).
  const cred = findCredentialForUser(userId);
  if (!cred) {
    return null;
  }

  let userToken: string;
  try {
    userToken = decryptGithubToken(cred.encrypted_token);
  } catch {
    // Decrypt error (e.g. wrong key) — treat as "not connected".
    return null;
  }

  return { token: userToken, source: "user" };
}
