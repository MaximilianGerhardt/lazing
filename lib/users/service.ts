/**
 * Users service (phase ORG SP-2).
 *
 * Business layer over `lib/users/repo.ts`. Encapsulates subject resolution
 * (currentUser via header) and audit-relevant operations.
 */

import { ulid } from "@/lib/ulid";
import {
  currentUserId,
  type RequestLike,
} from "@/lib/security/subject";
import {
  findActiveUserById,
  findUserByEmail,
  ensureUser as repoEnsureUser,
} from "./repo";
import type { UserRow } from "@/db/schema/users";

/**
 * Load the currently authenticated user from the DB.
 * Returns `null` when:
 *   - the subject is not a user (agent/system/anon)
 *   - userId is not in the DB
 *   - the user is suspended/deleted
 *   - userId is BOOTSTRAP_USER_ID (legacy cookie without backfill)
 */
export function loadCurrentUser(req: RequestLike): UserRow | null {
  const id = currentUserId(req);
  if (!id) return null;
  if (id === "max-bootstrap") return null;
  return findActiveUserById(id);
}

/**
 * Idempotent email-bound user lookup with auto-create.
 * Called by the magic-link verify (SP-3): the email comes from the
 * token, displayName is initially the email local part and can later
 * be overwritten during onboarding.
 */
export function ensureUserFromEmail(input: {
  email: string;
  displayName?: string;
  locale?: string;
}): UserRow {
  const existing = findUserByEmail(input.email);
  if (existing) return existing;
  const localPart = input.email.split("@")[0] ?? "user";
  return repoEnsureUser({
    id: `usr_${ulid()}`,
    email: input.email,
    displayName: input.displayName ?? localPart,
    locale: input.locale,
    emailVerifiedAt: new Date(),
  });
}
