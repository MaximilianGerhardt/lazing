/**
 * Users-Repository (Phase ORG SP-2).
 *
 * Reine DB-Operationen — kein Auth, keine Email, keine Magic-Link. Service-
 * Layer (`lib/users/service.ts`) wraps das mit Business-Logic.
 */

import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "@/db/client";
import { users, type UserInsert, type UserRow } from "@/db/schema/users";

export interface CreateUserInput {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string | null;
  locale?: string;
  emailVerifiedAt?: Date | null;
}

export function findUserById(id: string): UserRow | null {
  const db = getDb();
  const rows = db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function findUserByEmail(emailRaw: string): UserRow | null {
  const email = emailRaw.trim().toLowerCase();
  if (email.length === 0) return null;
  const db = getDb();
  const rows = db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

export function findActiveUserById(id: string): UserRow | null {
  const row = findUserById(id);
  if (!row) return null;
  if (row.status === "deleted" || row.status === "suspended") return null;
  return row;
}

export function createUser(input: CreateUserInput): UserRow {
  const db = getDb();
  const now = new Date();
  const insert: UserInsert = {
    id: input.id,
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName,
    avatarUrl: input.avatarUrl ?? null,
    locale: input.locale ?? "de-DE",
    status: "active",
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    onboardingState: null,
    onboardingCompletedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(users).values(insert).run();
  const fetched = findUserById(input.id);
  if (!fetched) {
    throw new Error(`createUser: insert verloren (id=${input.id})`);
  }
  return fetched;
}

/**
 * Idempotent: Wenn User mit der Email existiert → return ihn. Sonst
 * lege einen neuen mit übergebener ID + displayName an.
 */
export function ensureUser(input: CreateUserInput): UserRow {
  const existing = findUserByEmail(input.email);
  if (existing) return existing;
  return createUser(input);
}

export function updateUserOnboardingState(
  userId: string,
  state: Record<string, unknown> | null,
  completedAt: Date | null,
): void {
  const db = getDb();
  db.update(users)
    .set({
      onboardingState: state ? JSON.stringify(state) : null,
      onboardingCompletedAt: completedAt,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .run();
}

export function listActiveUsers(): UserRow[] {
  const db = getDb();
  return db
    .select()
    .from(users)
    .where(and(eq(users.status, "active"), isNull(users.deletedAt)))
    .all();
}

/**
 * Phase AU.0/AU.4 — liefert die ULID des ältesten aktiven Users mit
 * Founder-Rolle (über alle Orgs). Genutzt für:
 *   - Cookie-Migration: Bootstrap-Cookies werden auf diesen User remapped.
 *   - Login-Fallback: wenn LAZYOS_OWNER_EMAIL nicht gesetzt ist.
 *
 * Returns null wenn DB noch keinen Founder hat.
 */
export function findFirstFounderUserId(): string | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT u.id
         FROM users u
         INNER JOIN org_memberships m ON m.user_id = u.id
        WHERE m.role = 'founder'
          AND u.status = 'active'
          AND u.deleted_at IS NULL
        ORDER BY u.created_at ASC
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Phase MU.1 — Claude-MAX-Status pro User.
 *
 * `getClaudeMaxBinding` liefert den aktuellen Bindungsstatus inkl. Pfad.
 * `setClaudeMaxBinding` schreibt eine neue Konfig (Status + Pfad + Email).
 * Beide rein DB-Layer — Encryption + File-IO machen Caller (Service/Route).
 */
export interface ClaudeMaxBinding {
  status: "shared" | "own" | "none";
  credsPath: string | null;
  email: string | null;
  updatedAt: number | null;
}

export function getClaudeMaxBinding(userId: string): ClaudeMaxBinding | null {
  const db = getDb();
  const row = db.$raw
    .prepare(
      `SELECT claude_max_status as status,
              claude_max_creds_path as creds_path,
              claude_max_email as email,
              claude_max_updated_at as updated_at
         FROM users WHERE id = ?`,
    )
    .get(userId) as
    | {
        status: string;
        creds_path: string | null;
        email: string | null;
        updated_at: number | null;
      }
    | undefined;
  if (!row) return null;
  const status: ClaudeMaxBinding["status"] =
    row.status === "own" || row.status === "none" ? row.status : "shared";
  return {
    status,
    credsPath: row.creds_path,
    email: row.email,
    updatedAt: row.updated_at,
  };
}

export function setClaudeMaxBinding(
  userId: string,
  patch: {
    status: ClaudeMaxBinding["status"];
    credsPath?: string | null;
    email?: string | null;
  },
): void {
  const db = getDb();
  const now = Date.now();
  const sets: string[] = ["claude_max_status = ?", "claude_max_updated_at = ?"];
  const values: unknown[] = [patch.status, now];
  if (patch.credsPath !== undefined) {
    sets.push("claude_max_creds_path = ?");
    values.push(patch.credsPath);
  }
  if (patch.email !== undefined) {
    sets.push("claude_max_email = ?");
    values.push(patch.email);
  }
  sets.push("updated_at = ?");
  values.push(now);
  values.push(userId);
  db.$raw
    .prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values);
}
