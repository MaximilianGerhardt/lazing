/**
 * Sandbox-mode helper (P16, 2026-05-01).
 * ---------------------------------------
 *
 * Anne (Legaly-AI, quote): „was ist worst case... was sind die Rahmen-
 * bedingungen und dann in diesem Spielfeld, was klar abgesteckt ist, dann
 * aber auch Entscheidungen frei und schnell zuzulassen."
 *
 * Sandbox mode = "playing field clearly staked out + free hand WITHIN the field":
 *
 *   - Auto-approve after synthesis (no user click for sub-dispatch).
 *   - No push notifications for routine events
 *     (e.g. master-auto-closed, sub-dispatched-success).
 *   - Loop guard, multi-account isolation, credential gates stay ACTIVE.
 *
 * Constraint:
 *   Sandbox mode can ONLY be activated on workspace.sensitivity='low'.
 *   sensitivity='medium' / 'high' are explicitly excluded — that
 *   is the "clearly staked-out boundary condition". The guard `isSandbox()`
 *   enforces this even if someone sets the field directly to 1 in the DB.
 *
 * NOT allowed in sandbox:
 *   - Disabling the loop guard (NEVER — memory: „Drei Pflicht-Schichten OBLIGAT.")
 *   - Softening credential gates (TECH-008/012)
 *   - Cross-org bypasses
 */

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { workspaces as workspacesTable } from "../../db/schema/workspaces";
import type { Sensitivity, Workspace } from "../events/types";

export interface SandboxableWorkspace {
  sensitivity: Sensitivity;
  sandboxMode?: number;
}

/**
 * Pure function (test-friendly): reads both fields, returns true when
 * sandbox is active AND sensitivity allows it.
 *
 * Default behavior:
 *   - sandboxMode undefined / 0 → false
 *   - sensitivity != 'low' → false (even with sandboxMode=1 — safety floor)
 */
export function isSandbox(ws: SandboxableWorkspace): boolean {
  if (ws.sensitivity !== "low") return false;
  return ws.sandboxMode === 1;
}

/**
 * Constraint check for the toggle route. Returns a descriptive reason
 * when activation is NOT allowed, otherwise null.
 */
export function sandboxRejectionReason(
  ws: SandboxableWorkspace,
  enable: boolean,
): string | null {
  if (!enable) return null; // Deactivating is always ok
  if (ws.sensitivity !== "low") {
    return "sandbox-only-on-low-sensitivity";
  }
  return null;
}

/**
 * DB write: sets the flag and updates updated_at.
 * Throws when the workspace does not exist or the constraint is
 * violated. The caller (API route) must check permission + sensitivity first.
 */
export async function setSandboxMode(
  workspaceId: string,
  enabled: boolean,
): Promise<{ ok: true; sandboxMode: 0 | 1 }> {
  const db = getDb();
  const row = db
    .select()
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1)
    .all()[0];

  if (!row) {
    throw new Error(`workspace-not-found:${workspaceId}`);
  }

  const sensitivity = (row.sensitivity ?? "low") as Sensitivity;
  if (enabled && sensitivity !== "low") {
    throw new Error("sandbox-only-on-low-sensitivity");
  }

  const next: 0 | 1 = enabled ? 1 : 0;
  const now = Date.now();

  db.$raw
    .prepare("UPDATE workspaces SET sandbox_mode = ?, updated_at = ? WHERE id = ?")
    .run(next, now, workspaceId);

  return { ok: true, sandboxMode: next };
}

/**
 * Convenience: load the workspace directly from the DB and check sandbox.
 * Intended for hot-path callers (approval service, push service).
 *
 * Returns false when the workspace does not exist (defensive: no
 * auto-approve privileges for phantom IDs).
 */
export async function workspaceIsSandbox(
  workspaceId: string,
): Promise<boolean> {
  try {
    const db = getDb();
    const row = db
      .select({
        sensitivity: workspacesTable.sensitivity,
        sandboxMode: workspacesTable.sandboxMode,
      })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId))
      .limit(1)
      .all()[0];
    if (!row) return false;
    return isSandbox({
      sensitivity: (row.sensitivity ?? "low") as Sensitivity,
      sandboxMode: row.sandboxMode ?? 0,
    });
  } catch {
    return false;
  }
}

/**
 * Push-suppression list for sandbox workspaces. Routine events that
 * should NOT trigger a push in sandbox mode. The caller (push service)
 * filters before sending.
 *
 * Critical events (e.g. credential-violation, loop-guard-tripped,
 * security-alert) are DELIBERATELY NOT included here — they must
 * be notified even in sandbox.
 */
export const SANDBOX_SUPPRESSED_PUSH_RULES: ReadonlySet<string> = new Set([
  "master-auto-closed",
  "sub-dispatched-success",
  "sub-completed-success",
  "approval-request-routine",
  "synthesis-completed",
]);

export function shouldSuppressPushInSandbox(rule: string): boolean {
  return SANDBOX_SUPPRESSED_PUSH_RULES.has(rule);
}

export type { Workspace };
