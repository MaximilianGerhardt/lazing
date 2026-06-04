/**
 * Phase AU.4.1 — Bootstrap-Cookie Server-Migration.
 *
 * `subject.ts` is edge-safe (only parses headers). DB lookups must not
 * happen there. This file is node-only and encapsulates the
 * bootstrap-to-founder-ULID migration.
 *
 * Call pattern:
 *   const userId = currentUserIdResolved(req);
 *   if (!userId) return unauth(req);
 *
 * Returns:
 *   - the real ULID if the cookie is already a user cookie.
 *   - the first founder ULID if the cookie still has the legacy bootstrap format
 *     AND a founder exists in the DB.
 *   - null if the user is not logged in or no founder exists
 *     (fresh installation without setup).
 */

import { findFirstFounderUserId } from "@/lib/users/repo";
import { BOOTSTRAP_USER_ID } from "./session";
import { currentUserId, type RequestLike } from "./subject";

/**
 * Like `currentUserId(req)`, but resolves bootstrap cookies to the first
 * founder in the DB. The result is always a real ULID or null.
 */
export function currentUserIdResolved(req: RequestLike): string | null {
  const raw = currentUserId(req);
  if (!raw) return null;
  if (raw === BOOTSTRAP_USER_ID) {
    return findFirstFounderUserId();
  }
  return raw;
}

/**
 * Convenience: checks whether the user is logged in (real ULID, not
 * bootstrap). Returns a tuple `{ ok: true, userId } | { ok: false }`,
 * so routes can bail out directly via `if (!auth.ok)`.
 */
export function requireAuthenticatedUser(
  req: RequestLike,
): { ok: true; userId: string } | { ok: false } {
  const userId = currentUserIdResolved(req);
  if (!userId) return { ok: false };
  return { ok: true, userId };
}
