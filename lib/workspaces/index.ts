/**
 * Workspace-Registry — Read-API
 * -----------------------------
 * Thin wrapper around Drizzle queries on the `workspaces` table.
 * The write path lives in `scripts/discover-workspaces.ts` (admin-only).
 *
 * Accent policy:
 *   - the DB field is authoritative
 *   - falls back to `workspaceAccentFallback()` from `lib/events/types.ts`
 *     when the workspace is not in the DB (e.g. legacy events not yet
 *     migrated)
 */

import { asc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { workspaces as workspacesTable } from "../../db/schema/workspaces";
import type {
  Sensitivity,
  Workspace,
  WorkspaceAccent,
  WorkspaceId,
} from "../events/types";
import {
  WORKSPACE_ACCENTS,
  workspaceAccentFallback,
} from "../events/types";

function rowToWorkspace(row: typeof workspacesTable.$inferSelect): Workspace {
  return {
    id: row.id,
    label: row.label,
    accent: coerceAccent(row.accent),
    path: row.path,
    sensitivity: coerceSensitivity(row.sensitivity),
    archived: Boolean(row.archived),
    credentialOwner: row.credentialOwner ?? null,
    description: row.description ?? null,
    orgChart: row.orgChart ?? null,
    sandboxMode:
      typeof row.sandboxMode === "number" ? row.sandboxMode : 0,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt),
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.getTime() : Number(row.updatedAt),
  };
}

function coerceAccent(raw: string): WorkspaceAccent {
  return (WORKSPACE_ACCENTS as readonly string[]).includes(raw)
    ? (raw as WorkspaceAccent)
    : "own";
}

function coerceSensitivity(raw: string): Sensitivity {
  if (raw === "high" || raw === "medium" || raw === "low") return raw;
  return "low";
}

export async function listWorkspaces(opts?: {
  includeArchived?: boolean;
}): Promise<Workspace[]> {
  const db = getDb();
  const rows = db
    .select()
    .from(workspacesTable)
    .orderBy(asc(workspacesTable.id))
    .all();

  const all = rows.map(rowToWorkspace);
  if (opts?.includeArchived) return all;
  return all.filter((w) => !w.archived);
}

export async function getWorkspace(id: WorkspaceId): Promise<Workspace | null> {
  const db = getDb();
  const rows = db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, id))
    .limit(1)
    .all();
  const row = rows[0];
  return row ? rowToWorkspace(row) : null;
}

export async function workspaceAccent(
  id: WorkspaceId,
): Promise<WorkspaceAccent> {
  const ws = await getWorkspace(id);
  if (ws) return ws.accent;
  return workspaceAccentFallback(id);
}

/**
 * Lookup map id → label, convenient for server components that need to
 * render many IDs at once (e.g. Lanes, Calendar).
 */
export async function workspaceLabels(): Promise<Record<WorkspaceId, string>> {
  const all = await listWorkspaces({ includeArchived: true });
  const out: Record<WorkspaceId, string> = {};
  for (const w of all) out[w.id] = w.label;
  return out;
}
