/**
 * Sandbox-Mode-Helper (P16, 2026-05-01).
 * ---------------------------------------
 *
 * Anne (Legaly-AI, Quote): „was ist worst case... was sind die Rahmen-
 * bedingungen und dann in diesem Spielfeld, was klar abgesteckt ist, dann
 * aber auch Entscheidungen frei und schnell zuzulassen."
 *
 * Sandbox-Mode = „Spielfeld klar abgesteckt + freie Hand IM Spielfeld":
 *
 *   - Auto-Approve nach Synthesis (kein User-Click für Sub-Dispatch).
 *   - Keine Push-Notifications für Routine-Events
 *     (z.B. master-auto-closed, sub-dispatched-success).
 *   - Loop-Guard, Multi-Account-Isolation, Credential-Gates bleiben AKTIV.
 *
 * Constraint:
 *   Sandbox-Mode ist NUR auf workspace.sensitivity='low' aktivierbar.
 *   sensitivity='medium' / 'high' sind explizit ausgeschlossen — das
 *   ist die „klar abgesteckte Rahmenbedingung". Der Guard `isSandbox()`
 *   enforct das auch wenn jemand das Feld direkt in der DB auf 1 setzt.
 *
 * NICHT in Sandbox erlaubt:
 *   - Loop-Guard deaktivieren (NIE — Memory: „Drei Pflicht-Schichten OBLIGAT.")
 *   - Credential-Gates aufweichen (TECH-008/012)
 *   - Cross-Org-Bypässe
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
 * Reine Funktion (test-friendly): liest beide Felder, gibt true wenn
 * sandbox aktiv UND sensitivity erlaubt ist.
 *
 * Default-Verhalten:
 *   - sandboxMode undefined / 0 → false
 *   - sensitivity != 'low' → false (auch bei sandboxMode=1 — Safety-Floor)
 */
export function isSandbox(ws: SandboxableWorkspace): boolean {
  if (ws.sensitivity !== "low") return false;
  return ws.sandboxMode === 1;
}

/**
 * Constraint-Check für die Toggle-Route. Returnt einen sprechenden Grund
 * wenn die Aktivierung NICHT erlaubt ist, sonst null.
 */
export function sandboxRejectionReason(
  ws: SandboxableWorkspace,
  enable: boolean,
): string | null {
  if (!enable) return null; // Deaktivieren ist immer ok
  if (ws.sensitivity !== "low") {
    return "sandbox-only-on-low-sensitivity";
  }
  return null;
}

/**
 * DB-Write: setzt das Flag und aktualisiert updated_at.
 * Wirft wenn der Workspace nicht existiert oder das Constraint verletzt
 * wird. Caller (API-Route) muss vorher Permission + Sensitivity prüfen.
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
 * Convenience: lade Workspace direkt aus DB und prüfe Sandbox.
 * Für Hot-Path-Caller (Approval-Service, Push-Service) gedacht.
 *
 * Returnt false wenn Workspace nicht existiert (defensiv: keine
 * Auto-Approve-Privilegien für Phantom-IDs).
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
 * Push-Suppression-Liste für Sandbox-Workspaces. Routine-Events die
 * im Sandbox-Mode KEIN Push triggern sollen. Caller (push-service)
 * filtert vor dem Send.
 *
 * Critical-Events (z.B. credential-violation, loop-guard-tripped,
 * security-alert) sind hier BEWUSST NICHT enthalten — die müssen
 * auch im Sandbox notifiziert werden.
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
