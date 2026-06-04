/**
 * Users-Service (Phase ORG SP-2).
 *
 * Business-Layer über `lib/users/repo.ts`. Kapselt Subject-Resolution
 * (currentUser via Header) und audit-relevante Operationen.
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
 * Lade den aktuell authentisierten User aus der DB.
 * Returnt `null` wenn:
 *   - Subject ist kein User (agent/system/anon)
 *   - userId nicht in DB
 *   - User ist suspended/deleted
 *   - userId ist BOOTSTRAP_USER_ID (Legacy-Cookie ohne Backfill)
 */
export function loadCurrentUser(req: RequestLike): UserRow | null {
  const id = currentUserId(req);
  if (!id) return null;
  if (id === "max-bootstrap") return null;
  return findActiveUserById(id);
}

/**
 * Idempotent Email-bound User-Lookup mit Auto-Create.
 * Wird vom Magic-Link-Verify aufgerufen (SP-3): Email kommt aus dem
 * Token, displayName ist initial die Email-Lokalpart, kann später
 * im Onboarding überschrieben werden.
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
