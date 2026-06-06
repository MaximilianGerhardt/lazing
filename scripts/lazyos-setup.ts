#!/usr/bin/env tsx
/**
 * Phase AU.2.1 — `pnpm tsx scripts/lazyos-setup.ts`
 *
 * Atomic, idempotent first-boot setup. Replaces the combination of
 * `seed-organizations.ts` (Max-specific) + `backfill-users-from-env.ts`
 * for a fresh installation.
 *
 * Steps:
 *   1. Open the DB → triggers migrations.
 *   2. Create the default org + default workspace (see seed-default-org.ts).
 *   3. Create the owner user from ENV, if LAZYOS_OWNER_EMAIL is set.
 *   4. Founder membership for the owner in the default org.
 *   5. Workspace membership for the owner in the default workspace.
 *
 * Calling it multiple times is safe — all inserts with a pre-existence check.
 *
 * ENV:
 *   LAZYOS_OWNER_EMAIL          (optional, without it no user)
 *   LAZYOS_OWNER_DISPLAY_NAME   (optional, default "Owner")
 *   LAZYOS_DEFAULT_ORG_ID       (optional, default "workspace")
 *   LAZYOS_DEFAULT_ORG_NAME     (optional, default "My Workspace")
 *   LAZYOS_DEFAULT_WORKSPACE_ID (optional, default "default")
 *   LAZYOS_DEFAULT_WORKSPACE_LABEL (optional, default "Workspace")
 */

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  DEFAULT_ORG_ID,
  DEFAULT_ORG_NAME,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_WORKSPACE_LABEL,
} from "../lib/orgs/constants";
import { orgMemberships, workspaceMemberships } from "../db/schema/memberships";
import { organizations } from "../db/schema/organizations";
import { users } from "../db/schema/users";
import { workspaces } from "../db/schema/workspaces";
import { ulid } from "../lib/ulid";

interface StepOutcome {
  step: string;
  status: "[+] created" | "[=] existed" | "[-] skipped";
  detail?: string;
}

function fmt(rows: StepOutcome[]): string {
  const lines = rows.map(
    (r) =>
      `  ${r.status.padEnd(13)} ${r.step.padEnd(28)} ${r.detail ?? ""}`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const ownerEmail = process.env.LAZYOS_OWNER_EMAIL?.trim().toLowerCase();
  const ownerDisplay =
    process.env.LAZYOS_OWNER_DISPLAY_NAME?.trim() || "Owner";

  console.log("=== lazyOS Setup ===");
  console.log(`Default-Org:       ${DEFAULT_ORG_ID} (${DEFAULT_ORG_NAME})`);
  console.log(
    `Default-Workspace: ${DEFAULT_WORKSPACE_ID} (${DEFAULT_WORKSPACE_LABEL})`,
  );
  console.log(`Owner-Email:       ${ownerEmail ?? "<not set — skipping user>"}`);
  console.log("");

  const db = getDb();
  const now = new Date();
  const nowMs = now.getTime();
  const outcomes: StepOutcome[] = [];

  // 0. Built-in seeds (additive, idempotent, non-fatal). These run on every
  //    cold-start; they skip already-existing rows (no harm on
  //    multiple boots). NONE of the following org/user steps depend on this,
  //    so errors here are only logged (setup does NOT abort).
  //   - ensureBuiltInSops(): the 3 built-in SOPs (migration 0099 mirrors them
  //     via INSERT OR IGNORE; this programmatic re-seed also takes effect on
  //     an ephemeral /tmp-DB cold-start, cf. lib/sop/seed.ts doc).
  //   - ensureP5ToolConnectors(): the 3 Flow-Studio tool connectors (imagegen2 /
  //     higgsfield / heygen-avatar) in connector_catalog. These built-ins are
  //     seeded ONLY programmatically (there is no static seed migration for
  //     connector profiles — they run via upsertConnectorProfile). So that Flow
  //     Studio knows the tool coverage from the start.
  try {
    const { ensureBuiltInSops } = await import("../lib/sop/seed");
    ensureBuiltInSops();
    outcomes.push({ step: "builtin-sops", status: "[=] existed", detail: "ensured (idempotent)" });
  } catch (sopErr) {
    outcomes.push({
      step: "builtin-sops",
      status: "[-] skipped",
      detail: `seed failed (non-fatal): ${sopErr instanceof Error ? sopErr.message : String(sopErr)}`,
    });
  }
  try {
    const { ensureP5ToolConnectors } = await import(
      "../lib/connectors/p5-tool-connectors"
    );
    ensureP5ToolConnectors({ actor: "lazyos-setup" });
    outcomes.push({
      step: "p5-tool-connectors",
      status: "[=] existed",
      detail: "imagegen2/higgsfield/heygen-avatar ensured (idempotent)",
    });
  } catch (connErr) {
    outcomes.push({
      step: "p5-tool-connectors",
      status: "[-] skipped",
      detail: `seed failed (non-fatal): ${connErr instanceof Error ? connErr.message : String(connErr)}`,
    });
  }

  // 1. Default-Org
  const existingOrg = db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, DEFAULT_ORG_ID))
    .limit(1)
    .all();
  if (existingOrg.length === 0) {
    db.insert(organizations)
      .values({
        id: DEFAULT_ORG_ID,
        name: DEFAULT_ORG_NAME,
        type: "company",
        parentId: null,
        paletteIndex: 0,
        description:
          "Default-Organisation der laz.ing-Instanz. Sie hält den oder die ersten Workspaces.",
        archived: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    outcomes.push({
      step: "default-org",
      status: "[+] created",
      detail: DEFAULT_ORG_ID,
    });
  } else {
    outcomes.push({
      step: "default-org",
      status: "[=] existed",
      detail: DEFAULT_ORG_ID,
    });
  }

  // 2. Default-Workspace
  const existingWs = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, DEFAULT_WORKSPACE_ID))
    .limit(1)
    .all();
  if (existingWs.length === 0) {
    db.insert(workspaces)
      .values({
        id: DEFAULT_WORKSPACE_ID,
        label: DEFAULT_WORKSPACE_LABEL,
        accent: "own",
        path: "",
        sensitivity: "low",
        archived: false,
        description:
          "Default-Workspace, angelegt beim ersten Boot. Du kannst ihn umbenennen oder weitere Workspaces hinzufügen.",
        organizationId: DEFAULT_ORG_ID,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    outcomes.push({
      step: "default-workspace",
      status: "[+] created",
      detail: DEFAULT_WORKSPACE_ID,
    });
  } else {
    outcomes.push({
      step: "default-workspace",
      status: "[=] existed",
      detail: DEFAULT_WORKSPACE_ID,
    });
  }

  // 3. Owner user (only when ENV is set)
  let ownerUserId: string | null = null;
  if (ownerEmail) {
    const existingUser = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, ownerEmail))
      .limit(1)
      .all();
    if (existingUser.length === 0) {
      ownerUserId = `usr_${ulid()}`;
      db.insert(users)
        .values({
          id: ownerUserId,
          email: ownerEmail,
          displayName: ownerDisplay,
          locale: "de-DE",
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
      outcomes.push({
        step: "owner-user",
        status: "[+] created",
        detail: `${ownerUserId} (${ownerEmail})`,
      });
    } else {
      ownerUserId = existingUser[0].id;
      outcomes.push({
        step: "owner-user",
        status: "[=] existed",
        detail: `${ownerUserId} (${ownerEmail})`,
      });
    }
  } else {
    outcomes.push({
      step: "owner-user",
      status: "[-] skipped",
      detail: "LAZYOS_OWNER_EMAIL not set",
    });
  }

  // 4. Founder-Membership in Default-Org
  if (ownerUserId) {
    const existingMem = db.$raw
      .prepare(
        "SELECT id FROM org_memberships WHERE user_id = ? AND org_id = ?",
      )
      .get(ownerUserId, DEFAULT_ORG_ID) as { id: string } | undefined;
    if (!existingMem) {
      db.insert(orgMemberships)
        .values({
          id: `om_${ulid()}`,
          userId: ownerUserId,
          orgId: DEFAULT_ORG_ID,
          role: "founder",
          invitedByUserId: null,
          joinedAt: now,
          updatedAt: now,
        })
        .run();
      // set responsible_user_id on the org
      db.$raw
        .prepare(
          "UPDATE organizations SET responsible_user_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(ownerUserId, nowMs, DEFAULT_ORG_ID);
      outcomes.push({
        step: "founder-membership",
        status: "[+] created",
        detail: `${ownerUserId} → ${DEFAULT_ORG_ID}`,
      });
    } else {
      outcomes.push({
        step: "founder-membership",
        status: "[=] existed",
      });
    }

    // 5. Workspace-Membership (inherits-from-org)
    const existingWsMem = db.$raw
      .prepare(
        "SELECT id FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?",
      )
      .get(ownerUserId, DEFAULT_WORKSPACE_ID) as { id: string } | undefined;
    if (!existingWsMem) {
      db.insert(workspaceMemberships)
        .values({
          id: `wm_${ulid()}`,
          userId: ownerUserId,
          workspaceId: DEFAULT_WORKSPACE_ID,
          role: "founder",
          inheritsFromOrg: true,
          invitedByUserId: null,
          joinedAt: now,
          updatedAt: now,
        })
        .run();
      outcomes.push({
        step: "workspace-membership",
        status: "[+] created",
        detail: `${ownerUserId} → ${DEFAULT_WORKSPACE_ID}`,
      });
    } else {
      outcomes.push({
        step: "workspace-membership",
        status: "[=] existed",
      });
    }
  }

  console.log(fmt(outcomes));
  console.log("");
  console.log("=== Setup done ===");
  if (!ownerEmail) {
    console.log(
      "→ Operator bootstrap login: open /login and use the LAZYOS_ACCESS_CODE.",
    );
  } else {
    console.log("→ Login: open /login and enter your e-mail.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[lazyos-setup] failed:", err);
    process.exit(1);
  });
