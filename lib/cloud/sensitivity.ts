/**
 * Sensitivity-floor enforcement for the workspace cloud.
 *
 * Phase 1 (Day 1): cloud writes are blocked for workspaces with
 * `sensitivity = "high"` — demo-private, private, example-app-web, example-app-ios. Reason:
 * GDPR Art. 9 (special categories — health, sex life, religion)
 * requires encryption-at-rest, which is added in Phase 2.
 *
 * Reads are NOT blocked wholesale for sensitive workspaces —
 * if no data is stored, there is nothing to read. Once encryption
 * in Phase 2 stores data, its own auth rules apply there.
 *
 * Audit: every blocked attempt is written to `cloud_audit` with
 * `action = "blocked-sensitivity"` so cross-leak attempts are visible.
 */

import type { WorkspaceRow } from "@/db/schema/workspaces";
import { isEncryptionAvailable } from "@/lib/encryption/master-key";

export interface CloudWriteCheck {
  ok: boolean;
  reason?: string;
  errorCode?:
    | "sensitivity-floor"
    | "workspace-archived"
    | "workspace-unknown";
  /** Addition Phase ORG+1: the caller now knows whether it must use the encrypting backend. */
  requiresEncryption?: boolean;
}

const HIGH_SENSITIVITY = new Set(["high"]);

/**
 * Phase ORG+1 (2026-04-28): sensitivity='high' is allowed on write
 * PROVIDED the encryption layer is available (LAZYOS_MASTER_KEK set).
 * The service layer detects `requiresEncryption=true` and uses the
 * EncryptingStorageBackend instead of plain VPS-Disk.
 *
 * If the KEK is missing: the block remains, with a clear hint in the reason.
 */
export function canWriteToCloud(
  workspace: Pick<WorkspaceRow, "id" | "sensitivity" | "archived">,
): CloudWriteCheck {
  if (workspace.archived) {
    return {
      ok: false,
      reason: "Workspace ist archiviert — kein Cloud-Schreibzugriff.",
      errorCode: "workspace-archived",
    };
  }
  if (HIGH_SENSITIVITY.has(workspace.sensitivity)) {
    if (isEncryptionAvailable()) {
      return { ok: true, requiresEncryption: true };
    }
    return {
      ok: false,
      reason:
        "Workspace hat Sensitivity 'high' (DSGVO Art. 9). " +
        "Cloud-Schreibzugriff erfordert Encryption-Layer — setze LAZYOS_MASTER_KEK (64-hex-chars).",
      errorCode: "sensitivity-floor",
    };
  }
  return { ok: true };
}

/**
 * Read check: permissive today (see above). Hook for Phase-N
 * restrictions (e.g. share links with a time limit).
 */
export function canReadFromCloud(
  workspace: Pick<WorkspaceRow, "id" | "archived">,
): CloudWriteCheck {
  if (workspace.archived) {
    return {
      ok: false,
      reason:
        "Workspace ist archiviert — Read-Only via Direct-Storage-Snapshot, " +
        "nicht via Live-API.",
      errorCode: "workspace-archived",
    };
  }
  return { ok: true };
}
