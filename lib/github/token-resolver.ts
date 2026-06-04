/**
 * Token-Resolution für GitHub-Operationen im Workspace-Kontext.
 *
 * Priorität:
 *   1. Org-Token — wenn der Workspace einer Org zugeordnet ist UND die Org
 *      eine `org_github_credentials`-Row hat.
 *   2. User-Token — Fallback auf `github_credentials` des Users (bestehender
 *      Pfad für org-lose Workspaces oder Orgs ohne GitHub-Verbindung).
 *   3. null — keine GitHub-Verbindung vorhanden.
 *
 * Server-only. Token NIEMALS in Logs oder HTTP-Responses schreiben.
 */

import { decryptOrgToken } from "@/lib/github/org-repo";
import { findCredentialForUser } from "@/lib/github/repo";
import { decryptGithubToken } from "@/lib/github/client";
import { findOrgForWorkspace } from "@/lib/orgs/repo";

export interface ResolvedToken {
  token: string;
  /** 'org' wenn das Org-Token genutzt wird, 'user' beim User-Token-Fallback. */
  source: "org" | "user";
}

/**
 * Löst das für einen Workspace-Kontext zu verwendende GitHub-Token auf.
 *
 * Isolation-Invariante:
 *   - Org-Token wird nur genutzt wenn `findOrgForWorkspace` eine Org für
 *     den Workspace liefert UND `decryptOrgToken(orgId)` ein Token zurückgibt.
 *   - Ein User, der NICHT Member der zugehörigen Org ist, darf diesen
 *     Endpoint gar nicht erreichen (Caller-Pflicht: Auth-Check vor Aufruf).
 *   - Der Caller darf das zurückgegebene Token NIEMALS in Response-Body
 *     oder Logs schreiben.
 *
 * @param workspaceId  ID des Workspaces (aus URL-Param `[id]`).
 * @param userId       ID des authentifizierten Users (currentUserIdResolved).
 * @returns ResolvedToken oder null wenn keine Verbindung vorhanden.
 */
export function resolveGithubTokenForWorkspace(
  workspaceId: string,
  userId: string,
): ResolvedToken | null {
  // Schritt 1: Prüfe ob der Workspace einer Org zugeordnet ist.
  const org = findOrgForWorkspace(workspaceId);

  if (org) {
    // Schritt 2: Prüfe ob die Org ein GitHub-Token hat.
    // "token-resolver" als N8-Zweck für die Audit-Row.
    const orgToken = decryptOrgToken(org.id, "token-resolver");
    if (orgToken) {
      return { token: orgToken, source: "org" };
    }
  }

  // Schritt 3: Fallback auf User-Token (backward-compat für org-lose Workspaces
  // und Orgs ohne GitHub-Verbindung).
  const cred = findCredentialForUser(userId);
  if (!cred) {
    return null;
  }

  let userToken: string;
  try {
    userToken = decryptGithubToken(cred.encrypted_token);
  } catch {
    // Decrypt-Fehler (z.B. falscher Key) — behandle als "nicht verbunden".
    return null;
  }

  return { token: userToken, source: "user" };
}
