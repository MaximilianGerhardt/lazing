/**
 * SOP Registry — SAR-2 · 2026-05-24.
 *
 * CRUD surface for `sops` + `sop_steps`. Read-path is the primary concern for
 * Wave 1; write-path is best-effort for admin/seed use.
 *
 * N1:  step_prompt_template is persisted verbatim — NEVER sliced here.
 * N8:  archiveSop uses soft-delete (archived_at); no hard DELETE.
 * N10: contentHash is sha256 over a canonical JSON representation of the sop
 *      row (excluding content_hash itself). Computed here at write time.
 *
 * Dependencies: db/client.ts (getDb), db/schema/sops.ts. No LLM, no I/O side
 * effects — pure DB reads/writes.
 */

import { createHash } from "node:crypto";

import { and, asc, eq, isNull, or } from "drizzle-orm";

import { getDb } from "@/db/client";
import { sopSteps, sops } from "@/db/schema/sops";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SopWithSteps = {
  id: string;
  name: string;
  description: string | null | undefined;
  workspaceId: string | null | undefined;
  version: number;
  builtIn: boolean;
  archivedAt: number | null | undefined;
  contentHash: string;
  createdAt: number;
  steps: Array<{
    id: string;
    sopId: string;
    stepIndex: number;
    title: string;
    stepPromptTemplate: string;
    subagentRole: string | null;
    requiredSkillsJson: string | null;
    mcpToolAllowlistJson: string | null;
    optional: boolean;
  }>;
};

export type CreateSopInput = {
  id?: string;
  name: string;
  description?: string;
  workspaceId?: string;
  steps: Array<{
    title: string;
    /** N1: full prompt template — never truncate. */
    stepPromptTemplate: string;
    subagentRole?: string;
    requiredSkillsJson?: string;
    mcpToolAllowlistJson?: string;
    optional?: boolean;
  }>;
};

// ---------------------------------------------------------------------------
// Canonical JSON hash (N10)
// ---------------------------------------------------------------------------

/**
 * Compute the N10 content_hash for a sop row.
 * The hash covers: id, name, description, workspace_id, version, built_in,
 * created_at. It deliberately EXCLUDES content_hash itself and archived_at
 * (archived_at changes without creating a new SOP version).
 */
export function hashSop(row: {
  id: string;
  name: string;
  description: string | null | undefined;
  workspaceId: string | null | undefined;
  version: number;
  builtIn: boolean;
  createdAt: number;
}): string {
  const canonical = JSON.stringify({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    workspace_id: row.workspaceId ?? null,
    version: row.version,
    built_in: row.builtIn ? 1 : 0,
    created_at: row.createdAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Read: listSops
// ---------------------------------------------------------------------------

/**
 * List active (non-archived) SOPs.
 *
 * Returns global SOPs (workspace_id IS NULL) always, plus workspace-scoped SOPs
 * for the given workspaceId when provided.
 *
 * Does NOT include sop_steps — use getSop() for the full tree.
 */
export function listSops(workspaceId?: string): typeof sops.$inferSelect[] {
  const db = getDb();
  if (workspaceId) {
    return db
      .select()
      .from(sops)
      .where(
        and(
          isNull(sops.archivedAt),
          or(isNull(sops.workspaceId), eq(sops.workspaceId, workspaceId)),
        ),
      )
      .all();
  }
  // Global-only (no workspace filter)
  return db.select().from(sops).where(isNull(sops.archivedAt)).all();
}

// ---------------------------------------------------------------------------
// Read: getSop
// ---------------------------------------------------------------------------

/**
 * Load a single SOP with all its steps sorted by step_index ascending.
 *
 * Returns null when the SOP does not exist or is archived.
 */
export function getSop(id: string): SopWithSteps | null {
  const db = getDb();

  const sopRow = db
    .select()
    .from(sops)
    .where(and(eq(sops.id, id), isNull(sops.archivedAt)))
    .limit(1)
    .all()[0];

  if (!sopRow) return null;

  const steps = db
    .select()
    .from(sopSteps)
    .where(eq(sopSteps.sopId, id))
    .orderBy(asc(sopSteps.stepIndex))
    .all();

  return {
    ...sopRow,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Write: createSop
// ---------------------------------------------------------------------------

/**
 * Create a new SOP with its steps in a single transaction.
 *
 * N10: content_hash is computed here via hashSop() and stored.
 * N1:  stepPromptTemplate is stored verbatim — this function does NOT
 *      slice or modify it.
 */
export function createSop(input: CreateSopInput): SopWithSteps {
  const db = getDb();

  const id = input.id ?? `SOP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const now = Date.now();

  const sopData: typeof sops.$inferInsert = {
    id,
    name: input.name,
    description: input.description ?? null,
    workspaceId: input.workspaceId ?? null,
    version: 1,
    builtIn: false,
    archivedAt: null,
    contentHash: "", // filled below after hash
    createdAt: now,
  };

  const hash = hashSop({
    id,
    name: input.name,
    description: input.description ?? null,
    workspaceId: input.workspaceId ?? null,
    version: 1,
    builtIn: false,
    createdAt: now,
  });
  sopData.contentHash = hash;

  const stepRows: (typeof sopSteps.$inferInsert)[] = input.steps.map(
    (s, idx) => ({
      id: `SOPS-${id}-${idx}`,
      sopId: id,
      stepIndex: idx,
      title: s.title,
      stepPromptTemplate: s.stepPromptTemplate, // N1: verbatim, never truncated
      subagentRole: s.subagentRole ?? null,
      requiredSkillsJson: s.requiredSkillsJson ?? null,
      mcpToolAllowlistJson: s.mcpToolAllowlistJson ?? null,
      optional: s.optional ?? false,
    }),
  );

  db.transaction(() => {
    db.insert(sops).values(sopData).run();
    if (stepRows.length > 0) {
      db.insert(sopSteps).values(stepRows).run();
    }
  });

  const result: SopWithSteps = {
    id,
    name: input.name,
    description: input.description ?? null,
    workspaceId: input.workspaceId ?? null,
    version: 1,
    builtIn: false,
    archivedAt: null,
    contentHash: hash,
    createdAt: now,
    steps: stepRows as SopWithSteps["steps"],
  };
  return result;
}

// ---------------------------------------------------------------------------
// Write: archiveSop (soft-delete, N8)
// ---------------------------------------------------------------------------

/**
 * Soft-delete a SOP. Sets archived_at to the current timestamp.
 *
 * N8: never hard-deletes — the row remains as an audit record.
 * Built-in SOPs cannot be archived via this function (returns false).
 */
export function archiveSop(id: string): boolean {
  const db = getDb();

  const row = db
    .select({ builtIn: sops.builtIn, archivedAt: sops.archivedAt })
    .from(sops)
    .where(eq(sops.id, id))
    .limit(1)
    .all()[0];

  if (!row) return false;
  if (row.builtIn) return false; // Built-in SOPs are read-only
  if (row.archivedAt !== null) return false; // Already archived

  db.update(sops)
    .set({ archivedAt: Date.now() })
    .where(eq(sops.id, id))
    .run();

  return true;
}
