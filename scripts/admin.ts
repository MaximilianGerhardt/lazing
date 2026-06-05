/**
 * scripts/admin.ts — host-side admin recovery CLI.
 *
 * Run ON the machine (physical/SSH access = authority). The always-available
 * fallback when you're locked out (email broken, lost 2FA, no password set).
 *
 *   pnpm tsx scripts/admin.ts list-users
 *   pnpm tsx scripts/admin.ts create-admin <email> [displayName]
 *   pnpm tsx scripts/admin.ts set-password <email> <password>
 *   pnpm tsx scripts/admin.ts grant-founder <email>
 *   pnpm tsx scripts/admin.ts reset-2fa <email>
 *
 * (Also available without this: the LAZYOS_ACCESS_CODE master login.)
 */

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { users } from "../db/schema/users";
import { organizations } from "../db/schema/organizations";
import { orgMemberships } from "../db/schema/memberships";
import { DEFAULT_ORG_ID, DEFAULT_ORG_NAME } from "../lib/orgs/constants";
import { hashPassword } from "../lib/security/password";
import { ulid } from "../lib/ulid";

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}

function ensureDefaultOrg(): void {
  const db = getDb();
  const exists = db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, DEFAULT_ORG_ID))
    .all();
  if (exists.length === 0) {
    const now = new Date();
    db.insert(organizations)
      .values({
        id: DEFAULT_ORG_ID,
        name: DEFAULT_ORG_NAME,
        type: "company",
        parentId: null,
        paletteIndex: 0,
        description: "Default organization (created by admin CLI).",
        archived: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

function findUserByEmail(email: string): { id: string } | undefined {
  return getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
    .all()[0];
}

function grantFounder(userId: string): void {
  const db = getDb();
  ensureDefaultOrg();
  // If no membership row for this user+org, insert founder; else promote.
  const has = db.$raw
    .prepare(
      "SELECT COUNT(*) AS c FROM org_memberships WHERE user_id = ? AND org_id = ?",
    )
    .get(userId, DEFAULT_ORG_ID) as { c?: number } | undefined;
  const now = new Date();
  if ((has?.c ?? 0) === 0) {
    db.insert(orgMemberships)
      .values({
        id: `om_${ulid()}`,
        userId,
        orgId: DEFAULT_ORG_ID,
        role: "founder",
        invitedByUserId: null,
        joinedAt: now,
        updatedAt: now,
      })
      .run();
  } else {
    db.$raw
      .prepare(
        "UPDATE org_memberships SET role = 'founder', updated_at = ? WHERE user_id = ? AND org_id = ?",
      )
      .run(now.getTime(), userId, DEFAULT_ORG_ID);
  }
}

function main(): void {
  const [cmd, a1, a2] = process.argv.slice(2);
  const db = getDb();

  switch (cmd) {
    case "list-users": {
      const rows = db
        .select({ id: users.id, email: users.email, status: users.status })
        .from(users)
        .all();
      for (const r of rows) {
        const isFounder = db.$raw
          .prepare(
            "SELECT COUNT(*) AS c FROM org_memberships WHERE user_id = ? AND role = 'founder'",
          )
          .get(r.id) as { c?: number } | undefined;
        console.log(
          `${r.email}\t${r.status}\t${(isFounder?.c ?? 0) > 0 ? "founder" : "-"}\t${r.id}`,
        );
      }
      ok(`${rows.length} user(s)`);
      break;
    }
    case "create-admin": {
      if (!a1) die("usage: create-admin <email> [displayName]");
      const email = a1.trim().toLowerCase();
      let user = findUserByEmail(email);
      const now = new Date();
      if (!user) {
        const id = `usr_${ulid()}`;
        db.insert(users)
          .values({
            id,
            email,
            displayName: a2?.trim() || "Admin",
            locale: "en-US",
            status: "active",
            emailVerifiedAt: now,
            onboardingState: null,
            onboardingCompletedAt: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
            claudeMaxStatus: "shared",
          })
          .run();
        user = { id };
        ok(`created user ${email}`);
      }
      grantFounder(user.id);
      ok(`${email} is now a founder. Set a password: pnpm tsx scripts/admin.ts set-password ${email} <password>`);
      break;
    }
    case "grant-founder": {
      if (!a1) die("usage: grant-founder <email>");
      const user = findUserByEmail(a1.trim().toLowerCase());
      if (!user) die(`no user with email ${a1}`);
      grantFounder(user.id);
      ok(`${a1} is now a founder`);
      break;
    }
    case "set-password": {
      if (!a1 || !a2) die("usage: set-password <email> <password>");
      const user = findUserByEmail(a1.trim().toLowerCase());
      if (!user) die(`no user with email ${a1}`);
      const hash = hashPassword(a2);
      db.update(users)
        .set({ passwordHash: hash, updatedAt: new Date() })
        .where(eq(users.id, user.id))
        .run();
      ok(`password set for ${a1}`);
      break;
    }
    case "reset-2fa": {
      if (!a1) die("usage: reset-2fa <email>");
      const user = findUserByEmail(a1.trim().toLowerCase());
      if (!user) die(`no user with email ${a1}`);
      db.$raw
        .prepare(
          "UPDATE users SET totp_secret_ciphertext = NULL, totp_enabled_at = NULL, totp_last_used_at = NULL, totp_last_counter = NULL, updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), user.id);
      ok(`2FA reset for ${a1}`);
      break;
    }
    default:
      console.log(
        "Commands: list-users | create-admin <email> [name] | set-password <email> <password> | grant-founder <email> | reset-2fa <email>",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main();
