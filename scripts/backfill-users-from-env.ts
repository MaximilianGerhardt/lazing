#!/usr/bin/env -S pnpm tsx
/**
 * Phase ORG SP-9 — Backfill: Max as the first user in the multi-user DB.
 *
 * Before this script:
 *   - users table empty
 *   - org_memberships, workspace_memberships empty
 *   - audit_log empty
 *   - audit refs in the events table have actor='user:max' (literal)
 *   - cookies (before Phase ORG) have format `<ts>.<sig>` without a userId claim
 *
 * After this script:
 *   - users has 1 row: ULID owner (`max-<ulid>`) with LAZYOS_OWNER_EMAIL
 *   - org_memberships has N rows (1 per org as founder)
 *   - workspace_memberships has M rows (1 per WS, inherits-from-org=true)
 *   - organizations.responsible_user_id is set to the owner everywhere
 *   - events rows with actor='user:max' are remapped to actor='user:<ulid>'
 *   - audit_log gets a backfill entry
 *
 * Idempotent:
 *   - If the owner user already exists → no-op (with a hint print)
 *   - The script may run twice without drift
 *
 * Mandatory backup:
 *   - BEFORE run: SQLite file copy to `~/.lazyos/lazyos.db.pre-phase-org.<ts>.bak`
 *   - The script checks whether a backup exists and creates it if not
 *
 * Invocation:
 *   pnpm tsx scripts/backfill-users-from-env.ts
 *   pnpm tsx scripts/backfill-users-from-env.ts --dry-run
 *   LAZYOS_OWNER_EMAIL=... LAZYOS_OWNER_DISPLAY_NAME=... pnpm tsx scripts/backfill-users-from-env.ts
 */

import { copyFileSync, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { auditLog } from "../db/schema/audit_log";
import {
  orgMemberships,
  workspaceMemberships,
} from "../db/schema/memberships";
import { organizations } from "../db/schema/organizations";
import { users } from "../db/schema/users";
import { workspaces as workspacesTable } from "../db/schema/workspaces";
import { ulid } from "../lib/ulid";

// Phase AU.0.2: no more personal defaults. ENV-driven.
const DEFAULT_OWNER_EMAIL: string | null = null;
const DEFAULT_OWNER_DISPLAY = "Owner";

interface BackfillSummary {
  ownerUserId: string;
  ownerEmail: string;
  alreadyExisted: boolean;
  orgMembershipsInserted: number;
  workspaceMembershipsInserted: number;
  organizationsResponsibleSet: number;
  eventsActorRemapped: number;
  backupPath: string | null;
  dryRun: boolean;
}

function ensureBackup(dryRun: boolean): string | null {
  const dbPath =
    process.env.LAZYOS_DB_PATH ?? path.join(os.homedir(), ".lazyos", "lazyos.db");
  if (!existsSync(dbPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.pre-phase-org.${ts}.bak`;
  if (dryRun) return `${backupPath} (would-create)`;
  copyFileSync(dbPath, backupPath);
  const size = statSync(backupPath).size;
  console.log(`[backup] ${backupPath} (${size} bytes)`);
  return backupPath;
}

function resolveOwnerEmail(): string {
  const raw =
    process.env.LAZYOS_OWNER_EMAIL?.trim().toLowerCase() ?? DEFAULT_OWNER_EMAIL;
  if (!raw) {
    throw new Error(
      "LAZYOS_OWNER_EMAIL nicht gesetzt. Setze die ENV-Variable bevor du das Backfill-Skript ausführst.",
    );
  }
  if (!raw.includes("@")) {
    throw new Error(`LAZYOS_OWNER_EMAIL ist kein valider Email-String: '${raw}'`);
  }
  return raw;
}

function resolveOwnerDisplay(): string {
  return (
    process.env.LAZYOS_OWNER_DISPLAY_NAME?.trim() || DEFAULT_OWNER_DISPLAY
  );
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  console.log("=== Phase ORG SP-9 — Backfill ===");
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);

  const backupPath = ensureBackup(dryRun);

  const db = getDb();
  const ownerEmail = resolveOwnerEmail();
  const ownerDisplay = resolveOwnerDisplay();
  console.log(`Owner-Email: ${ownerEmail}`);
  console.log(`Owner-Display: ${ownerDisplay}`);

  // ----- 1. Create owner user idempotently -----
  const existing = db
    .select()
    .from(users)
    .where(eq(users.email, ownerEmail))
    .limit(1)
    .all();
  let ownerUserId: string;
  let alreadyExisted: boolean;
  if (existing.length > 0) {
    ownerUserId = existing[0].id;
    alreadyExisted = true;
    console.log(`[users] existiert bereits: ${ownerUserId}`);
  } else {
    ownerUserId = `usr_${ulid()}`;
    alreadyExisted = false;
    if (!dryRun) {
      const now = new Date();
      db.insert(users)
        .values({
          id: ownerUserId,
          email: ownerEmail,
          displayName: ownerDisplay,
          locale: "de-DE",
          status: "active",
          emailVerifiedAt: now,
          // Mark onboarding as done immediately for the owner — he already
          // knows his own lazyOS.
          onboardingState: JSON.stringify({
            variant: "max-firstrun",
            completedSteps: [1, 2, 3, 4, 5, 6],
            completedAt: now.toISOString(),
          }),
          onboardingCompletedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    console.log(`[users] insert: ${ownerUserId}`);
  }

  // ----- 2. Org memberships for every org as founder -----
  const allOrgs = db.select().from(organizations).all();
  let orgMembershipsInserted = 0;
  for (const org of allOrgs) {
    const exists = db
      .select()
      .from(orgMemberships)
      .where(
        sql`${orgMemberships.userId} = ${ownerUserId} AND ${orgMemberships.orgId} = ${org.id}`,
      )
      .limit(1)
      .all();
    if (exists.length > 0) continue;
    if (!dryRun) {
      const now = new Date();
      db.insert(orgMemberships)
        .values({
          id: `om_${ulid()}`,
          userId: ownerUserId,
          orgId: org.id,
          role: "founder",
          invitedByUserId: null,
          joinedAt: now,
          updatedAt: now,
        })
        .run();
    }
    orgMembershipsInserted++;
  }
  console.log(
    `[org_memberships] inserted=${orgMembershipsInserted}, total-orgs=${allOrgs.length}`,
  );

  // ----- 3. Workspace memberships (inherits-from-org=true) -----
  const allWorkspaces = db.select().from(workspacesTable).all();
  let workspaceMembershipsInserted = 0;
  for (const ws of allWorkspaces) {
    const exists = db
      .select()
      .from(workspaceMemberships)
      .where(
        sql`${workspaceMemberships.userId} = ${ownerUserId} AND ${workspaceMemberships.workspaceId} = ${ws.id}`,
      )
      .limit(1)
      .all();
    if (exists.length > 0) continue;
    if (!dryRun) {
      const now = new Date();
      db.insert(workspaceMemberships)
        .values({
          id: `wm_${ulid()}`,
          userId: ownerUserId,
          workspaceId: ws.id,
          role: "founder",
          inheritsFromOrg: true,
          invitedByUserId: null,
          joinedAt: now,
          updatedAt: now,
        })
        .run();
    }
    workspaceMembershipsInserted++;
  }
  console.log(
    `[workspace_memberships] inserted=${workspaceMembershipsInserted}, total-ws=${allWorkspaces.length}`,
  );

  // ----- 4. Set organizations.responsible_user_id -----
  let organizationsResponsibleSet = 0;
  if (!dryRun) {
    for (const org of allOrgs) {
      const orgWithExtended = db.$raw
        .prepare("SELECT responsible_user_id FROM organizations WHERE id = ?")
        .get(org.id) as { responsible_user_id: string | null } | undefined;
      if (orgWithExtended?.responsible_user_id) continue;
      db.$raw
        .prepare(
          "UPDATE organizations SET responsible_user_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(ownerUserId, Date.now(), org.id);
      organizationsResponsibleSet++;
    }
  } else {
    organizationsResponsibleSet = allOrgs.length;
  }
  console.log(
    `[organizations.responsible_user_id] set=${organizationsResponsibleSet}`,
  );

  // ----- 5. events table: actor='user:max' → 'user:<ulid>' -----
  let eventsActorRemapped = 0;
  if (!dryRun) {
    const result = db.$raw
      .prepare("UPDATE events SET actor = ? WHERE actor = ?")
      .run(`user:${ownerUserId}`, "user:max");
    eventsActorRemapped = result.changes ?? 0;
    // Bootstrap marker too → real ULID.
    const result2 = db.$raw
      .prepare("UPDATE events SET actor = ? WHERE actor = ?")
      .run(`user:${ownerUserId}`, "user:max-bootstrap");
    eventsActorRemapped += result2.changes ?? 0;
  } else {
    const c1 = db.$raw
      .prepare("SELECT COUNT(*) AS n FROM events WHERE actor = 'user:max'")
      .get() as { n: number };
    const c2 = db.$raw
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE actor = 'user:max-bootstrap'",
      )
      .get() as { n: number };
    eventsActorRemapped = (c1?.n ?? 0) + (c2?.n ?? 0);
  }
  console.log(`[events] actor-remapped=${eventsActorRemapped}`);

  // ----- 6. cloud_audit table: actor='user:max' → 'user:<ulid>' -----
  let cloudAuditRemapped = 0;
  if (!dryRun) {
    try {
      const r = db.$raw
        .prepare("UPDATE cloud_audit SET actor = ? WHERE actor = ?")
        .run(`user:${ownerUserId}`, "user:max");
      cloudAuditRemapped = r.changes ?? 0;
      const r2 = db.$raw
        .prepare("UPDATE cloud_audit SET actor = ? WHERE actor = ?")
        .run(`user:${ownerUserId}`, "user:max-bootstrap");
      cloudAuditRemapped += r2.changes ?? 0;
    } catch {
      // cloud_audit may not exist yet — never mind.
    }
  }
  console.log(`[cloud_audit] actor-remapped=${cloudAuditRemapped}`);

  // ----- 7. Write audit-log entry -----
  if (!dryRun) {
    const now = new Date();
    db.insert(auditLog)
      .values({
        id: `aud_${ulid()}`,
        ts: now,
        actor: "system:backfill",
        action: "user.created",
        targetUserId: ownerUserId,
        payload: JSON.stringify({
          source: "phase-org-sp9-backfill",
          ownerEmail,
          ownerDisplay,
          alreadyExisted,
          orgMembershipsInserted,
          workspaceMembershipsInserted,
          organizationsResponsibleSet,
          eventsActorRemapped,
          cloudAuditRemapped,
        }),
      })
      .run();
  }

  // ----- Summary -----
  const summary: BackfillSummary = {
    ownerUserId,
    ownerEmail,
    alreadyExisted,
    orgMembershipsInserted,
    workspaceMembershipsInserted,
    organizationsResponsibleSet,
    eventsActorRemapped,
    backupPath,
    dryRun,
  };
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    dryRun
      ? "\n(dry-run — keine Writes erfolgt. Re-run ohne --dry-run um zu commiten.)"
      : "\n✓ Phase ORG Backfill complete.",
  );
}

main().catch((err) => {
  console.error("[backfill] FAILED:", err);
  process.exit(1);
});
