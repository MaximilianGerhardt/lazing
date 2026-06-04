#!/usr/bin/env tsx
/**
 * Phase AU.0 — Default-Org-Seed für fresh-installation.
 *
 * Legt eine generische Default-Org + Default-Workspace an, sodass eine
 * fresh-installation von lazyOS sofort lauffähig ist. Idempotent.
 *
 * KEINE persönlichen Daten. Generisch für jeden Operator.
 *
 *   - Default-Org-ID:       LAZYOS_DEFAULT_ORG_ID  (default "workspace")
 *   - Default-Org-Name:     LAZYOS_DEFAULT_ORG_NAME (default "My Workspace")
 *   - Default-Workspace-ID: LAZYOS_DEFAULT_WORKSPACE_ID (default "default")
 *
 * Wird aus scripts/lazyos-setup.ts aufgerufen, kann aber auch standalone
 * ausgeführt werden:
 *
 *   pnpm tsx scripts/seed-default-org.ts
 */

import Database from "better-sqlite3";
import path from "node:path";

const DB_PATH =
  process.env.LAZYOS_DB_PATH ??
  path.join(process.env.HOME ?? "/root", ".lazyos", "lazyos.db");

const DEFAULT_ORG_ID = process.env.LAZYOS_DEFAULT_ORG_ID ?? "workspace";
const DEFAULT_ORG_NAME = process.env.LAZYOS_DEFAULT_ORG_NAME ?? "My Workspace";
const DEFAULT_WORKSPACE_ID =
  process.env.LAZYOS_DEFAULT_WORKSPACE_ID ?? "default";
const DEFAULT_WORKSPACE_LABEL =
  process.env.LAZYOS_DEFAULT_WORKSPACE_LABEL ?? "Workspace";

interface SeedResult {
  org: "created" | "existed";
  workspace: "created" | "existed";
}

export function seedDefaultOrg(dbPath: string = DB_PATH): SeedResult {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  const now = Date.now();
  const result: SeedResult = { org: "existed", workspace: "existed" };

  try {
    const existingOrg = db
      .prepare("SELECT id FROM organizations WHERE id = ?")
      .get(DEFAULT_ORG_ID);
    if (!existingOrg) {
      db.prepare(
        `INSERT INTO organizations (
           id, name, type, parent_id, palette_index, description,
           archived, created_at, updated_at
         ) VALUES (?, ?, 'company', NULL, 0, ?, 0, ?, ?)`,
      ).run(
        DEFAULT_ORG_ID,
        DEFAULT_ORG_NAME,
        "Default-Organisation der lazyOS-Instanz. Sie hält den oder die ersten Workspaces.",
        now,
        now,
      );
      result.org = "created";
    }

    const existingWs = db
      .prepare("SELECT id FROM workspaces WHERE id = ?")
      .get(DEFAULT_WORKSPACE_ID);
    if (!existingWs) {
      db.prepare(
        `INSERT INTO workspaces (
           id, label, accent, path, sensitivity, archived, description,
           organization_id, created_at, updated_at
         ) VALUES (?, ?, 'own', '', 'low', 0, ?, ?, ?, ?)`,
      ).run(
        DEFAULT_WORKSPACE_ID,
        DEFAULT_WORKSPACE_LABEL,
        "Default-Workspace, angelegt beim ersten Boot. Du kannst ihn umbenennen oder weitere Workspaces hinzufügen.",
        DEFAULT_ORG_ID,
        now,
        now,
      );
      result.workspace = "created";
    }
  } finally {
    db.close();
  }

  return result;
}

if (require.main === module) {
  const out = seedDefaultOrg();
  console.log(`[seed-default-org] org=${out.org} workspace=${out.workspace}`);
}
